import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Optional keytar/libsecret fallback for the passphrase. Loaded lazily so the rest of
// pi-chrome still works on systems without libsecret/DPAPI.
type KeytarModule = {
	getPassword(service: string, account: string): Promise<string | null>;
	setPassword(service: string, account: string, password: string): Promise<void>;
	deletePassword(service: string, account: string): Promise<boolean>;
};
let keytarPromise: Promise<KeytarModule | null> | undefined;
function loadKeytar(): Promise<KeytarModule | null> {
	if (!keytarPromise) {
		// @ts-expect-error - keytar is an optional dependency; install manually when available
		keytarPromise = import("keytar")
			.then((mod) => mod as unknown as KeytarModule)
			.catch(() => null);
	}
	return keytarPromise;
}
const KEYTAR_SERVICE = "pi-chrome-credentials";
const KEYTAR_ACCOUNT = "passphrase-v1";

/**
 * Existing-profile Chrome bridge for pi.
 *
 * This is intentionally not a remote-debugging-port integration. Chrome blocks default-profile
 * remote debugging in many normal launches, so pi-chrome uses a companion extension from the
 * browser-extension folder bundled next to this Pi extension.
 *
 * The companion extension runs inside the user's real Chrome profile and polls this local
 * pi extension for commands. That gives pi access to the user's existing tabs/authenticated
 * profile, subject to the browser extension permissions the user grants.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

type BridgeCommand = {
	id: string;
	action: string;
	params: Record<string, unknown>;
};

type PendingCommand = {
	command: BridgeCommand;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	deliveredAt?: number;
};

type BridgeResult = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

// Look up the pi-chrome package version in a few well-known places. The companion extension
// lives in a separate codebase (typically somewhere under /mnt/c/Users/... on this WSL box,
// or wherever the user did `Load unpacked` on brave://extensions). When omp can't find a
// nearby package.json it falls back to a dev sentinel so the bridge still works.
const PI_CHROME_PKG_CANDIDATES = [
	"/mnt/c/Users/benjamin.steimer/pi-chrome/package.json",         // Brave user's local fork (authoritative when present)
	resolve(__dirname, "..", "..", "package.json"),                 // standard sibling layout
	resolve(__dirname, "..", "..", "..", "package.json"),            // one level higher
];
function readPiChromeVersion(): string {
	for (const candidate of PI_CHROME_PKG_CANDIDATES) {
		try {
			const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
			if (pkg.version) return pkg.version;
		} catch {}
	}
	return "0.0.0-dev";
}
const PI_CHROME_VERSION = readPiChromeVersion();
const PI_CHROME_GLOBAL_KEY = "__piChromeProfileBridgeLoaded__";
// Authorization is kept on globalThis (separate from the singleton flag, which is cleared on
// reload) so a /reload — which tears down and re-evaluates the module — does not silently drop
// an active /chrome authorize grant.
const PI_CHROME_AUTH_KEY = "__piChromeProfileBridgeAuth__";
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 30_000;
const MAX_ELEMENTS = 80;
const BACKGROUND_PARAM_DESCRIPTION = "If true, avoid explicit Chrome focus/tab activation for this call. /chrome background on (default) enforces this for every call and ignores false. Ask the user to run /chrome background off to allow foreground work.";

function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

const snapshotModeValues = ["auto", "interactive", "forms", "pageMap", "text", "changes", "full"] as const;

function compactLine(value: unknown, max = 140): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rectText(rect: any): string {
	if (!rect) return "?";
	return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function formatChromeSnapshot(snapshot: any): string {
	if (!snapshot || typeof snapshot !== "object") return safeJson(snapshot);
	if (snapshot.mode === "full") return truncateText(safeJson(snapshot));
	const lines: string[] = [];
	lines.push(`# Chrome snapshot${snapshot.mode ? ` (${snapshot.mode})` : ""}`);
	lines.push(`${snapshot.title || "(untitled)"}`);
	if (snapshot.url) lines.push(`${snapshot.url}`);
	if (snapshot.viewport) lines.push(`viewport=${snapshot.viewport.width}x${snapshot.viewport.height} scroll=${snapshot.viewport.scrollX || 0},${snapshot.viewport.scrollY || 0}`);
	if (snapshot.summary?.modal) lines.push(`modal: ${snapshot.summary.modal.uid} ${compactLine(snapshot.summary.modal.label)}`);
	if (snapshot.summary?.focused) lines.push(`focused: ${snapshot.summary.focused.uid} ${snapshot.summary.focused.role || ""} ${compactLine(snapshot.summary.focused.label)}`);
	if (Array.isArray(snapshot.summary?.hints) && snapshot.summary.hints.length) {
		lines.push("\n## Hints");
		for (const hint of snapshot.summary.hints.slice(0, 6)) lines.push(`- ${hint}`);
	}
	if (snapshot.diff && !snapshot.diff.firstSnapshot) {
		const changed = [
			...(snapshot.diff.changes || []).map((c: any) => c.kind === "textChanged" ? "text changed" : `${c.kind}: ${compactLine(c.before, 50)} → ${compactLine(c.after, 50)}`),
			...(snapshot.diff.added || []).slice(0, 4).map((e: any) => `added ${e.uid} ${e.role || ""} ${compactLine(e.label)}`),
			...(snapshot.diff.updated || []).slice(0, 4).map((u: any) => `updated ${u.uid} ${compactLine(u.after?.label || u.before?.label)}`),
		];
		if (changed.length) {
			lines.push("\n## Changed since last snapshot");
			for (const item of changed.slice(0, 10)) lines.push(`- ${item}`);
		}
	}
	if (Array.isArray(snapshot.matches) && snapshot.matches.length) {
		lines.push(`\n## Matches for "${snapshot.query}"`);
		for (const match of snapshot.matches.slice(0, 12)) {
			if (match.kind === "text") lines.push(`- ${match.uid} text ${compactLine(match.text)} @ ${rectText(match.rect)}`);
			else if (match.kind === "region") lines.push(`- ${match.uid} region ${compactLine(match.label)} headings=${(match.headings || []).map((h: string) => compactLine(h, 50)).join(" | ")}`);
			else lines.push(`- ${match.uid} ${match.role || match.tag || "element"}${match.disabled ? " disabled" : ""} ${compactLine(match.label || match.selector)} @ ${rectText(match.rect)}`);
		}
	}
	if (snapshot.mode === "pageMap" && snapshot.pageMap) {
		lines.push("\n## Page map");
		for (const region of (snapshot.pageMap.regions || []).slice(0, 18)) {
			lines.push(`- ${region.uid} ${region.kind}: ${compactLine(region.label)}`);
			for (const action of (region.actions || []).slice(0, 5)) lines.push(`  - ${action.uid} ${action.role || ""}${action.disabled ? " disabled" : ""} ${compactLine(action.label)}`);
		}
		if (snapshot.pageMap.headings?.length) {
			lines.push("\nHeadings:");
			for (const h of snapshot.pageMap.headings.slice(0, 20)) lines.push(`- ${h.uid} h${h.level || ""} ${compactLine(h.text)}`);
		}
	}
	if (Array.isArray(snapshot.layout) && snapshot.layout.length && snapshot.mode !== "changes") {
		lines.push("\n## Layout / context");
		for (const section of snapshot.layout.slice(0, snapshot.mode === "pageMap" ? 18 : 8)) {
			const bits = [`${section.uid}`, section.role || section.tag, compactLine(section.label || section.text || "(unnamed section)", 110), `@ ${rectText(section.rect)}`];
			lines.push(`- ${bits.filter(Boolean).join(" ")}`);
			const fieldLabels = (section.fields || []).slice(0, 4).map((f: any) => `${f.uid} ${compactLine(f.label || f.role, 40)}`);
			const actionLabels = (section.actions || []).slice(0, 5).map((a: any) => `${a.uid}${a.disabled ? " disabled" : ""} ${compactLine(a.label || a.role, 40)}`);
			if (fieldLabels.length) lines.push(`  fields: ${fieldLabels.join("; ")}`);
			if (actionLabels.length) lines.push(`  actions: ${actionLabels.join("; ")}`);
		}
	}
	if ((snapshot.mode === "forms" || snapshot.forms?.fields?.length) && snapshot.mode !== "pageMap") {
		const fields = snapshot.forms?.fields || [];
		const submits = snapshot.forms?.submits || [];
		if (fields.length || submits.length) lines.push("\n## Forms");
		for (const field of fields.slice(0, snapshot.mode === "forms" ? 40 : 12)) {
			const bits = [field.uid, field.role || field.tag, field.required ? "required" : "", field.invalid ? "invalid" : "", field.disabled ? "disabled" : "", compactLine(field.label || field.selector, 90)];
			if (field.value) bits.push(`value=${compactLine(field.value, 50)}`);
			else if (field.valueRedacted) bits.push("value=[redacted]");
			lines.push(`- ${bits.filter(Boolean).join(" ")} @ ${rectText(field.rect)}`);
		}
		for (const submit of submits.slice(0, 8)) lines.push(`- ${submit.uid} submit/action${submit.disabled ? " disabled" : ""} ${compactLine(submit.label || submit.selector)} @ ${rectText(submit.rect)}`);
	}
	if (Array.isArray(snapshot.elements) && snapshot.mode !== "pageMap") {
		lines.push("\n## Visible actions");
		for (const el of snapshot.elements.slice(0, snapshot.mode === "interactive" ? 60 : 25)) {
			const flags = [el.disabled ? "disabled" : "", el.occluded ? `occluded-by-${el.occluded.tag}` : ""].filter(Boolean).join(",");
			const context = el.context?.label ? ` in ${el.context.uid} ${compactLine(el.context.label, 60)}` : "";
			lines.push(`- ${el.uid} ${el.role || el.tag}${flags ? ` [${flags}]` : ""} ${compactLine(el.label || el.selector)}${context} @ ${rectText(el.rect)}`);
		}
		if (snapshot.elements.length > (snapshot.mode === "interactive" ? 60 : 25)) lines.push(`- … ${snapshot.elements.length - (snapshot.mode === "interactive" ? 60 : 25)} more; retry with maxElements or mode=interactive`);
	}
	if ((snapshot.mode === "text" || snapshot.mode === "auto") && Array.isArray(snapshot.textSnippets) && snapshot.textSnippets.length) {
		lines.push("\n## Text snippets");
		for (const snip of snapshot.textSnippets.slice(0, snapshot.mode === "text" ? 40 : 14)) lines.push(`- ${snip.uid} ${compactLine(snip.text, snapshot.mode === "text" ? 240 : 160)}`);
		if (snapshot.textTruncated) lines.push("- … page text truncated; retry with mode=text or maxTextChars for more");
	}
	lines.push("\nTip: use chrome_snapshot({query:'...', mode:'interactive|forms|pageMap|text|changes|full'}) or nearUid to zoom in.");
	return truncateText(lines.join("\n"));
}

function formatIncludedSnapshotText(raw: unknown, text: string): string {
	const snapshot = raw && typeof raw === "object" ? (raw as { snapshot?: unknown }).snapshot : undefined;
	return snapshot ? `${text}\n\n${formatChromeSnapshot(snapshot)}` : text;
}

function formatChromeInspect(inspect: any): string {
	if (!inspect || typeof inspect !== "object") return safeJson(inspect);
	const t = inspect.target || {};
	const lines: string[] = [];
	lines.push(`# Chrome inspect ${t.uid || ""}`.trim());
	lines.push(`${t.role || t.tag || "element"}${t.disabled ? " disabled" : ""}${t.occluded ? ` occluded-by-${t.occluded.tag}` : ""} ${compactLine(t.label || t.selector)}`);
	if (t.selector) lines.push(`selector: ${t.selector}`);
	if (t.rect) lines.push(`rect: ${rectText(t.rect)}`);
	if (inspect.clickSuggestion) lines.push(`suggested click: chrome_click({ uid: "${inspect.clickSuggestion.uid}" }) or x=${inspect.clickSuggestion.x}, y=${inspect.clickSuggestion.y}`);
	if (Array.isArray(inspect.nearbyText) && inspect.nearbyText.length) {
		lines.push("\n## Nearby text");
		for (const item of inspect.nearbyText.slice(0, 12)) lines.push(`- ${item.uid} ${compactLine(item.text, 180)}`);
	}
	if (inspect.formContext) {
		lines.push("\n## Form context");
		for (const field of (inspect.formContext.fields || []).slice(0, 20)) lines.push(`- ${field.uid} ${field.role || field.tag}${field.disabled ? " disabled" : ""} ${compactLine(field.label || field.selector)}${field.value ? ` value=${compactLine(field.value, 60)}` : field.valueRedacted ? " value=[redacted]" : ""}`);
		for (const action of (inspect.formContext.actions || []).slice(0, 10)) lines.push(`- ${action.uid} action${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)}`);
	}
	if (Array.isArray(inspect.nearbyActions) && inspect.nearbyActions.length) {
		lines.push("\n## Nearby actions");
		for (const action of inspect.nearbyActions.slice(0, 18)) lines.push(`- ${action.uid} ${action.role || action.tag}${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)} @ ${rectText(action.rect)}`);
	}
	if (Array.isArray(inspect.ancestors) && inspect.ancestors.length) {
		lines.push("\n## Ancestors");
		for (const a of inspect.ancestors.slice(0, 6)) lines.push(`- ${a.uid} ${a.role || a.tag} ${compactLine(a.label || a.selector, 120)}`);
	}
	return truncateText(lines.join("\n"));
}

function extensionRoot(): string {
	// Resolve relative to this extension file, not ctx.cwd. ctx.cwd can temporarily be
	// an attachment/clipboard path when Pi is handling pasted images.
	if (typeof __dirname === "string") return __dirname;
	return process.cwd();
}

function workspaceCwd(ctx: ExtensionContext): string {
	for (const candidate of [ctx.cwd, process.cwd()]) {
		if (!candidate) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// try next candidate
		}
	}
	return process.cwd();
}

function browserExtensionPath(): string {
	return join(extensionRoot(), "browser-extension");
}

function hostnameOf(url: string | undefined): string {
	if (!url) return "";
	try { return new URL(url).hostname; } catch { return ""; }
}

// ===============================================================
// Encrypted credentials store (auto-relogin helper)
// ===============================================================
// Stores saved login credentials in $HOME/.pi-chrome/credentials.json (chmod 600).
// Passwords are encrypted with AES-256-GCM; the symmetric key is derived via scrypt
// from a passphrase that lives in keytar/libsecret/DPAPI when available, else a
// machine-local fallback (random per install, kept next to the file as `.fallback`,
// also chmod 600). Never read this file from the browser-extension — the bridge
// owns all crypto and the worker only sees decrypted values over the wire, scoped
// to a single fill invocation.
const PI_CHROME_DIR = join(homedir(), ".pi-chrome");
const CREDENTIALS_FILE = join(PI_CHROME_DIR, "credentials.json");
const CREDENTIALS_AUDIT_FILE = join(PI_CHROME_DIR, "credentials.audit.log");
const CREDENTIALS_FALLBACK_FILE = join(PI_CHROME_DIR, "credentials.fallback");
const CREDENTIALS_FILE_MODE = 0o600;
const CREDENTIALS_DIR_MODE = 0o700;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
const CREDENTIALS_KDF_ID = "scrypt-v1";
const RATE_LIMIT_PER_HOUR = 5;

type PasswordCipher = {
	iv: string;            // base64
	tag: string;           // base64
	ciphertext: string;    // base64
	keyId: string;
	kdf: "scrypt";
	kdfParams: { N: number; r: number; p: number; salt: string };
};

type CredentialAlias = {
	name: string;
	host: string;
	username: string;
	passwordCipher: PasswordCipher;
	updatedAt: number;
	lastUsedAt?: number;
};

type CredentialsStore = {
	aliases: CredentialAlias[];
};

async function ensurePiChromeDir(): Promise<void> {
	await mkdir(PI_CHROME_DIR, { recursive: true, mode: CREDENTIALS_DIR_MODE });
	try {
		chmodSync(PI_CHROME_DIR, CREDENTIALS_DIR_MODE);
	} catch {
		// Some WSL mounts don't honor chmod; that's fine — the file modes below still matter.
	}
}

function trySecureFile(filePath: string, contents: string): void {
	try {
		writeFileSync(filePath, contents, { mode: CREDENTIALS_FILE_MODE });
		chmodSync(filePath, CREDENTIALS_FILE_MODE);
	} catch {
		// Surface via the calling path; the credentials module is best-effort on FS-restricted hosts.
	}
}

// One-time generation of a 32-byte random passphrase. Stored in keytar when libsecret is
// available; falls back to a chmod-600 file under ~/.pi-chrome/. Either path keeps the
// passphrase off the wire and out of process listings. We never persist the passphrase
// in plaintext anywhere reachable from a browser context.
let passphraseCache: string | undefined;
async function loadOrCreatePassphrase(): Promise<string> {
	if (passphraseCache) return passphraseCache;
	const keytar = await loadKeytar();
	if (keytar) {
		const stored = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT).catch(() => null);
		if (stored) {
			passphraseCache = stored;
			return stored;
		}
		const fresh = randomBytes(32).toString("base64");
		await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, fresh).catch(() => undefined);
		passphraseCache = fresh;
		return fresh;
	}
	await ensurePiChromeDir();
	let existing: string | null = null;
	try {
		existing = readFileSync(CREDENTIALS_FALLBACK_FILE, "utf8");
	} catch {
		existing = null;
	}
	if (existing && existing.length >= 32) {
		passphraseCache = existing.trim();
		return passphraseCache;
	}
	const fresh = randomBytes(32).toString("base64");
	trySecureFile(CREDENTIALS_FALLBACK_FILE, fresh);
	passphraseCache = fresh;
	return fresh;
}

async function loadCredentialsStore(): Promise<CredentialsStore> {
	try {
		const raw = readFileSync(CREDENTIALS_FILE, "utf8");
		const parsed = JSON.parse(raw) as CredentialsStore;
		if (!parsed || !Array.isArray(parsed.aliases)) return { aliases: [] };
		// Defensive: drop any aliases that fail to parse their cipher shape.
		parsed.aliases = parsed.aliases.filter((alias) => alias && alias.name && alias.host && alias.username && alias.passwordCipher);
		return parsed;
	} catch {
		return { aliases: [] };
	}
}

async function saveCredentialsStore(store: CredentialsStore): Promise<void> {
	await ensurePiChromeDir();
	const serialized = JSON.stringify(store, null, 2);
	trySecureFile(CREDENTIALS_FILE, serialized);
}

async function encryptSecret(plaintext: string, passphrase: string): Promise<PasswordCipher> {
	const salt = randomBytes(16);
	const key = scryptSync(passphrase, salt, SCRYPT_PARAMS.keylen, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: 256 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2 });
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	const keyId = CREDENTIALS_KDF_ID;
	return {
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
		keyId,
		kdf: "scrypt",
		kdfParams: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, salt: salt.toString("base64") },
	};
}

async function decryptSecret(cipher: PasswordCipher, passphrase: string): Promise<string> {
	if (cipher.kdf !== "scrypt") throw new Error(`Unsupported KDF: ${cipher.kdf}`);
	const { N, r, p, salt } = cipher.kdfParams;
	const key = scryptSync(passphrase, Buffer.from(salt, "base64"), SCRYPT_PARAMS.keylen, { N, r, p, maxmem: 256 * N * r * 2 });
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipher.iv, "base64"));
	decipher.setAuthTag(Buffer.from(cipher.tag, "base64"));
	const plaintext = Buffer.concat([decipher.update(Buffer.from(cipher.ciphertext, "base64")), decipher.final()]);
	return plaintext.toString("utf8");
}

function appendCredentialsAudit(entry: Record<string, unknown>): void {
	try {
		ensurePiChromeDir().catch(() => undefined);
		const line = JSON.stringify({ ...entry, ts: entry.ts ?? Date.now() }) + "\n";
		// Append using a sync writeFile so the audit never silently drops lines; mode is set on
		// file create only — append keeps it 0600.
		try {
			// Use the promisified variant to avoid blocking, then ensure mode on first create.
			writeFile(CREDENTIALS_AUDIT_FILE, line, { mode: CREDENTIALS_FILE_MODE, flag: "a" }).catch(() => undefined);
		} catch {
			// No-op: audit failures must never break the fill flow.
		}
	} catch {
		// Audit failures must never break the fill flow.
	}
}

function credentialsListSummary(alias: CredentialAlias): { name: string; host: string; lastUsedAt?: number } {
	return { name: alias.name, host: alias.host, lastUsedAt: alias.lastUsedAt };
}

async function credentialsList(): Promise<{ aliases: Array<{ name: string; host: string; lastUsedAt?: number }> }> {
	const store = await loadCredentialsStore();
	return { aliases: store.aliases.map(credentialsListSummary) };
}

async function credentialsAdd(params: { name: string; host: string; username: string; password: string }): Promise<{ name: string; host: string; updatedAt: number }> {
	const name = String(params.name || "").trim();
	const host = String(params.host || "").trim().toLowerCase();
	const username = String(params.username || "");
	const password = String(params.password || "");
	if (!name) throw new Error("credentials.add: name is required");
	if (!host) throw new Error("credentials.add: host is required");
	if (!username) throw new Error("credentials.add: username is required");
	if (!password) throw new Error("credentials.add: password is required");
	const passphrase = await loadOrCreatePassphrase();
	const cipher = await encryptSecret(password, passphrase);
	const store = await loadCredentialsStore();
	const updatedAt = Date.now();
	const next: CredentialAlias = {
		name,
		host,
		username,
		passwordCipher: cipher,
		updatedAt,
	};
	const idx = store.aliases.findIndex((alias) => alias.name === name);
	if (idx >= 0) store.aliases[idx] = next; else store.aliases.push(next);
	await saveCredentialsStore(store);
	return { name, host, updatedAt };
}

async function credentialsRemove(name: string): Promise<{ removed: boolean }> {
	const store = await loadCredentialsStore();
	const before = store.aliases.length;
	store.aliases = store.aliases.filter((alias) => alias.name !== name);
	await saveCredentialsStore(store);
	return { removed: store.aliases.length < before };
}

const credentialsFillAttempts = new Map<string, number[]>();
function credentialsRateLimitCheck(alias: string): { ok: boolean; remaining: number; resetAt: number } {
	const now = Date.now();
	const windowMs = 60 * 60 * 1000;
	const arr = (credentialsFillAttempts.get(alias) ?? []).filter((t) => now - t < windowMs);
	if (arr.length >= RATE_LIMIT_PER_HOUR) {
		const resetAt = arr[0] + windowMs;
		return { ok: false, remaining: 0, resetAt };
	}
	arr.push(now);
	credentialsFillAttempts.set(alias, arr);
	return { ok: true, remaining: RATE_LIMIT_PER_HOUR - arr.length, resetAt: now + windowMs };
}

type BridgeSender = (action: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

async function credentialsFill(args: {
	alias: string;
	tabId?: number;
	host: string;
	usernameUid?: string;
	usernameSelector?: string;
	passwordUid?: string;
	passwordSelector?: string;
	submitSelector?: string;
	background?: boolean;
	send: BridgeSender;
}): Promise<unknown> {
	const aliasName = String(args.alias || "").trim();
	if (!aliasName) throw new Error("credentials.fill: alias is required");
	const expectedHost = String(args.host || "").trim().toLowerCase();
	if (!expectedHost) throw new Error("credentials.fill: host is required");

	const store = await loadCredentialsStore();
	const entry = store.aliases.find((alias) => alias.name === aliasName);
	if (!entry) throw new Error(`credentials.fill: no alias named '${aliasName}'`);
	if (entry.host.toLowerCase() !== expectedHost) {
		throw new Error(`credentials.fill: alias '${aliasName}' is bound to host '${entry.host}', refusing to fill on '${expectedHost}'`);
	}

	const limit = credentialsRateLimitCheck(aliasName);
	if (!limit.ok) {
		const minutes = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60_000));
		throw new Error(`credentials.fill: rate limit exceeded for '${aliasName}'; try again in ${minutes}m (5 attempts/hour cap).`);
	}

	const passphrase = await loadOrCreatePassphrase();
	const password = await decryptSecret(entry.passwordCipher, passphrase);

	// MFA / CAPTCHA short-circuit: probe the page for a TOTP field or a known challenge iframe.
	// We don't try to solve these — we surface the error so the caller can hand off to a human.
	const probe = await args.send("page.evaluate", {
		expression: `(() => {
			const totpHints = ["totp", "2fa", "mfa", "verification", "authenticator", "otp", "one-time"];
			const hasTotpField = Array.from(document.querySelectorAll("input")).some((el) => {
				const blob = [
					el.id || "", el.name || "", el.autocomplete || "", el.placeholder || "",
					(el.getAttribute("aria-label") || ""), (el.getAttribute("data-testid") || ""),
				].join(" ").toLowerCase();
				return el.type !== "hidden" && totpHints.some((hint) => blob.includes(hint));
			});
			const captchaIframes = Array.from(document.querySelectorAll("iframe")).filter((f) => {
				const src = (f.src || "").toLowerCase();
				return /hcaptcha|recaptcha/.test(src);
			});
			return { hasTotpField, captchaIframes: captchaIframes.length };
		})()`,
		background: args.background !== true,
	}).catch(() => null) as { hasTotpField?: boolean; captchaIframes?: number } | null;

	if (probe?.hasTotpField) {
		throw new Error("credentials.fill: detected a TOTP/2FA field on the page; refusing to auto-fill. Ask the user to complete 2FA manually.");
	}
	if (probe && (probe.captchaIframes ?? 0) > 0) {
		throw new Error("credentials.fill: detected a CAPTCHA iframe (hCaptcha/reCAPTCHA); refusing to auto-fill. Ask the user to solve the challenge.");
	}

	const tabId = args.tabId;
	const fillParams: Record<string, unknown> = {
		...(tabId !== undefined ? { targetId: tabId } : {}),
		background: args.background !== true,
	};
	// Split into two wire calls: 'credentials.fill' (step=username) then 'credentials.fill'
	// (step=password). The worker owns hostname re-validation + MFA/CAPTCHA short-circuit and
	// drives chromeInputType for each step. We never send the password in cleartext to the
	// worker — it travels only inside the encrypted bridge session via the credentials.fill
	// wire action, scoped to one invocation.
	const usernameResult = await args.send("credentials.fill", {
		...fillParams,
		step: "username",
		host: expectedHost,
		value: entry.username,
		...(args.usernameUid ? { uid: args.usernameUid } : {}),
		...(args.usernameSelector ? { selector: args.usernameSelector } : {}),
	}, DEFAULT_TIMEOUT_MS);
	const passwordResult = await args.send("credentials.fill", {
		...fillParams,
		step: "password",
		host: expectedHost,
		value: password,
		...(args.passwordUid ? { uid: args.passwordUid } : {}),
		...(args.passwordSelector ? { selector: args.passwordSelector } : {}),
	}, DEFAULT_TIMEOUT_MS);

	let submitResult: unknown;
	if (args.submitSelector) {
		submitResult = await args.send("page.click", {
			...fillParams,
			selector: args.submitSelector,
		}, DEFAULT_TIMEOUT_MS);
	}

	// Best-effort update lastUsedAt; never block the response on a write failure.
	entry.lastUsedAt = Date.now();
	saveCredentialsStore(store).catch(() => undefined);

	appendCredentialsAudit({
		alias: aliasName,
		host: expectedHost,
		tabId: tabId ?? null,
		ok: true,
	});

	return {
		ok: true,
		alias: aliasName,
		host: expectedHost,
		usernameLength: entry.username.length,
		passwordLength: password.length,
		usernameResult,
		passwordResult,
		submitResult,
		rateLimitRemaining: limit.remaining,
	};
}

// Description of a click/type/fill result's significant fields so the agent doesn't have to
// guess whether the action actually changed the page.
function summarizeActionResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	const parts: string[] = [];
	// NOTE: pageMutated is a coarse heuristic (a hash over body text + input values + node count).
	// Many real effects — class/aria/data-state toggles, JS-held state, canvas, async updates —
	// don't move it, so a false value is NOT proof the action did nothing. Surface it only as a
	// soft hint, and never present it as a failure on its own.
	if (r.pageMutated === false) parts.push("no coarse DOM change detected (may still have taken effect — verify with includeSnapshot)");
	if (r.defaultPrevented === true) parts.push("defaultPrevented=true");
	if (r.elementVisible === false) parts.push("element NOT visible");
	if (r.occludedBy) {
		const o = r.occludedBy as { tag?: string; id?: string };
		parts.push(`occluded by <${o.tag ?? "?"}${o.id ? "#" + o.id : ""}>`);
	}
	if (r.valueMatches === false) parts.push("input value did not stick");
	if (r.usedReact === true) parts.push("filled via React native value setter");
	if (r.verified === false) parts.push(`verifyExpr did not become truthy after ${r.verifyAttempts ?? 0} click attempt(s)`);
	if (r.autoplayHint) parts.push("autoplay-gated affordance");
	return parts.length ? parts.join("; ") : undefined;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		request.on("error", rejectBody);
	});
}

function corsHeadersFor(request: IncomingMessage): Record<string, string> {
	const origin = String(request.headers.origin ?? "");
	if (!origin.startsWith("chrome-extension://")) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-expose-headers": "x-pi-chrome-version",
		"vary": "origin",
	};
}

function isBrowserOriginAllowed(request: IncomingMessage): boolean {
	const origin = String(request.headers.origin ?? "");
	if (origin) return origin.startsWith("chrome-extension://");
	const secFetchSite = String(request.headers["sec-fetch-site"] ?? "");
	return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}

function isLocalProcessRequest(request: IncomingMessage): boolean {
	return !request.headers.origin && !request.headers["sec-fetch-site"];
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...(extraHeaders ?? {}),
	});
	response.end(JSON.stringify(body));
}
class ChromeProfileBridge {
	private server: Server | undefined;
	private pending = new Map<string, PendingCommand>();
	private queue: BridgeCommand[] = [];
	private waiters: Array<(command: BridgeCommand | undefined) => void> = [];
	private lastSeenAt: number | undefined;
	private clientName: string | undefined;
	private mode: "server" | "client" | undefined;
	// Optional callback for control-plane requests (authorize / revoke / doctor / background).
	// The bridge class does not know about Pi plugin internals; the host plugin attaches a
	// handler that knows how to drive its own auth/background/doctor state. The callback
	// returns null to signal "not a control request, fall through to default handling".
	onControlRequest: ((url: URL, request: IncomingMessage, response: ServerResponse) => Promise<boolean>) | undefined;

	private enqueue(command: BridgeCommand): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(command);
		else this.queue.push(command);
	}

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {}

	get url(): string {
		return `http://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		// MV3 service workers can pause between polls/alarms. Treat a recent poll as
		// connected without sending a probe command; real chrome_* tool calls are
		// the authoritative end-to-end health check.
		return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 5 * 60_000;
	}

	status(): Record<string, unknown> {
		return {
			url: this.url,
			mode: this.mode ?? "starting",
			connected: this.connected,
			lastSeenAt: this.lastSeenAt,
			clientName: this.clientName,
			queuedCommands: this.queue.length,
			pendingCommands: this.pending.size,
		};
	}

	async start(): Promise<void> {
		if (this.server || this.mode === "client") return;
		await this.bindServerOrClient();
	}

	// Try to own the bridge port. On success we are the server; on EADDRINUSE another Pi
	// session owns it and we run as a client that forwards commands to that owner.
	private async bindServerOrClient(): Promise<void> {
		const server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				sendJson(response, 500, { error: (error as Error).message });
			});
		});
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				server.once("error", rejectStart);
				server.listen(this.port, this.host, () => {
					server.off("error", rejectStart);
					resolveStart();
				});
			});
			this.server = server;
			this.mode = "server";
		} catch (error) {
			server.close();
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// Another Pi session already owns the bridge port. Use it as the shared
			// machine-local broker so multiple Pi sessions can control Chrome at once.
			this.mode = "client";
		}
	}

	// Client-mode self-heal: when the owning Pi session disappears, fetches to its port fail
	// with `fetch failed` / ECONNREFUSED forever. Try to grab the now-free port and become the
	// server ourselves so chrome_* tools recover without a manual restart.
	private async tryPromoteToServer(): Promise<boolean> {
		if (this.mode !== "client") return this.mode === "server";
		this.mode = undefined;
		await this.bindServerOrClient();
		return this.mode === "server";
	}

	stop(): void {
		if (this.mode === "client") {
			this.mode = undefined;
			return;
		}
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Chrome profile bridge stopped"));
		}
		this.pending.clear();
		this.queue = [];
		for (const waiter of this.waiters) waiter(undefined);
		this.waiters = [];
		this.server?.close();
		this.server = undefined;
		this.mode = undefined;
	}

	send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		if (this.mode === "client") return this.sendViaOwner(action, params, timeoutMs, signal);
		return this.sendLocal(action, params, timeoutMs, signal);
	}

	private sendLocal(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const command = { id, action, params };
		return new Promise((resolveCommand, rejectCommand) => {
			if (signal?.aborted) {
				rejectCommand(new Error("Chrome command aborted"));
				return;
			}
			const cleanupAbort = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error("Chrome command aborted"));
			};
			const timer = setTimeout(() => {
				const entry = this.pending.get(id);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error(this.timeoutMessage(entry, timeoutMs)));
			}, timeoutMs);
			this.pending.set(id, {
				command,
				resolve: (value) => { cleanupAbort(); resolveCommand(value); },
				reject: (err) => { cleanupAbort(); rejectCommand(err); },
				timer,
			});
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.enqueue(command);
		});
	}

	// Classify why a local command timed out so the agent isn't left guessing. The three
	// distinct failure modes are: extension never polled (not installed / not running),
	// extension polled but never picked up this command, and extension picked up the command
	// but never posted a result back (long-running action or a failed /result post).
	private timeoutMessage(entry: PendingCommand | undefined, timeoutMs: number): string {
		const pollAgeMs = this.lastSeenAt === undefined ? undefined : Date.now() - this.lastSeenAt;
		if (entry?.deliveredAt) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension received the command but never returned a result. The action may be long-running, or the result post failed. Run /chrome doctor; if it persists, reload 'Pi Chrome Connector' at chrome://extensions.`;
		}
		if (pollAgeMs === undefined || pollAgeMs > 60_000) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension is not polling (last seen ${pollAgeMs === undefined ? "never" : Math.round(pollAgeMs / 1000) + "s ago"}). Run /chrome onboard, then load the bundled browser-extension folder in your normal Chrome profile and keep that Chrome window open.`;
		}
		return `Timed out after ${timeoutMs}ms: the Chrome extension is polling (last seen ${Math.round(pollAgeMs / 1000)}s ago) but did not pick up this command in time. Retry; if it persists, reload 'Pi Chrome Connector' at chrome://extensions.`;
	}

	private async sendViaOwner(action: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
		const forwardAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", forwardAbort, { once: true });
		}
		try {
			const response = await fetch(`${this.url}/command`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action, params, timeoutMs }),
				signal: controller.signal,
			});
			const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
			if (response.status === 404) {
				throw new Error(
					"A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
				);
			}
			if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
			return payload.result;
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				if (signal?.aborted) throw new Error("Chrome command aborted");
				throw new Error(`Timed out waiting for shared Chrome bridge owner after ${timeoutMs}ms`);
			}
			// `fetch failed` / ECONNREFUSED means the Pi session that owned the bridge port is gone.
			// Try to take over the port ourselves and re-run the command locally instead of staying
			// stuck as a client pointed at a dead owner.
			if (this.isOwnerUnreachable(error)) {
				const promoted = await this.tryPromoteToServer().catch(() => false);
				if (promoted) return this.sendLocal(action, params, timeoutMs, signal);
				throw new Error(
					"The Pi session that owned the Chrome bridge is unreachable and this session could not take over the bridge port. Restart this Pi session, or run /chrome doctor.",
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", forwardAbort);
		}
	}

	private isOwnerUnreachable(error: unknown): boolean {
		const message = (error as Error)?.message ?? "";
		const code = (error as NodeJS.ErrnoException)?.code ?? "";
		const cause = (error as { cause?: NodeJS.ErrnoException })?.cause;
		const causeCode = cause?.code ?? "";
		return (
			/fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(message) ||
			code === "ECONNREFUSED" ||
			causeCode === "ECONNREFUSED" ||
			causeCode === "ECONNRESET"
		);
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const corsHeaders = corsHeadersFor(request);
		if (request.method === "OPTIONS") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		// Allow the host plugin to claim control-plane requests before the bridge's default
		// route table. The host callback returns true once it has handled the request.
		if (this.onControlRequest && request.method === "GET" && url.pathname === "/__pi_chrome_control") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			const handled = await this.onControlRequest(url, request, response);
			if (handled) return;
		}
		// /health is the lightweight liveness endpoint the Chrome companion polls on every tick.
		// Same payload shape as /status (so existing clients keep parsing unchanged), but the
		// response explicitly carries `cache-control: no-store` to defeat any intermediary cache
		// that might otherwise serve a stale {connected:true} long after the bridge died. The
		// companion probes /health first with a tight 750ms budget and falls back to /status
		// only when the server does not yet recognize the route (older pi-chrome releases).
		if (request.method === "GET" && url.pathname === "/health") {
			sendJson(response, 200, this.status(), corsHeaders);
			return;
		}
		if (request.method === "GET" && url.pathname === "/status") {
			sendJson(response, 200, this.status());
			return;
		}
		if (request.method === "POST" && url.pathname === "/command") {
			if (!isLocalProcessRequest(request)) {
				sendJson(response, 403, { ok: false, error: "Chrome commands are accepted only from local Pi processes" });
				return;
			}
			const body = JSON.parse(await readRequestBody(request)) as {
				action?: string;
				params?: Record<string, unknown>;
				timeoutMs?: number;
			};
			if (!body.action) {
				sendJson(response, 400, { ok: false, error: "Missing command action" });
				return;
			}
			try {
				const result = await this.sendLocal(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				sendJson(response, 200, { ok: true, result });
			} catch (error) {
				sendJson(response, 504, { ok: false, error: (error as Error).message });
			}
			return;
		}
		if (request.method === "GET" && url.pathname === "/next") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			this.clientName = url.searchParams.get("name") ?? undefined;
			let aborted = false;
			let activeWaiter: ((command: BridgeCommand | undefined) => void) | undefined;
			request.once("close", () => {
				aborted = true;
				if (activeWaiter) this.waiters = this.waiters.filter((entry) => entry !== activeWaiter);
			});
			let command = this.queue.shift();
			if (!command) {
				command = await this.waitForCommand(25_000, (waiter) => {
					activeWaiter = waiter;
				});
			}
			if (aborted) {
				// Long-poll connection died before we could deliver. Requeue any command we pulled
				// so the next live /next picks it up instead of dropping it on the floor.
				if (command) this.queue.unshift(command);
				return;
			}
			// Mark the command as delivered so a later timeout can distinguish "extension never
			// picked it up" from "extension is running it / failed to post a result".
			if (command) {
				const entry = this.pending.get(command.id);
				if (entry) entry.deliveredAt = Date.now();
			}
			// Re-read version on every /next so bumping package.json takes effect without pi restart.
			const currentVersion = readPiChromeVersion();
			sendJson(
				response,
				200,
				command
					? { type: "command", command, expectedExtensionVersion: currentVersion }
					: { type: "none", expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion },
			);
			return;
		}
		if (request.method === "POST" && url.pathname === "/result") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			const result = JSON.parse(await readRequestBody(request)) as BridgeResult;
			const pending = this.pending.get(result.id);
			if (!pending) {
				sendJson(response, 404, { ok: false, error: "unknown command id" }, corsHeaders);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(result.id);
			if (result.ok) pending.resolve(result.result);
			else pending.reject(new Error(result.error ?? "Chrome extension command failed"));
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		// Automation shell: serves a tiny HTML page on the bridge origin itself so the Chrome
		// companion can use chrome.scripting.executeScript and chrome.debugger.attach against
		// it (host_permissions cover http://127.0.0.1:17318/*). about:blank / data: / the
		// companion's own extension origin are all rejected by chrome.scripting in practice,
		// so the only universally-scriptable target is a real URL on a permitted origin.
		if (request.method === "GET" && url.pathname === "/__pi_chrome_shell") {
			const shell = "<!doctype html><meta charset=\"utf-8\"><title>Pi Chrome</title>";
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			});
			response.end(shell);
			return;
		}
		sendJson(response, 404, { error: "not found" });
	}

	private waitForCommand(
		timeoutMs: number,
		registerWaiter?: (waiter: (command: BridgeCommand | undefined) => void) => void,
	): Promise<BridgeCommand | undefined> {
		return new Promise((resolveWait) => {
			let settled = false;
			const waiter = (command: BridgeCommand | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.waiters = this.waiters.filter((entry) => entry !== waiter);
				resolveWait(command);
			};
			const timer = setTimeout(() => waiter(undefined), timeoutMs);
			this.waiters.push(waiter);
			registerWaiter?.(waiter);
		});
	}
}

const tabActionValues = ["list", "new", "activate", "close", "group", "ungroup", "version"] as const;
const imageFormatValues = ["png", "jpeg"] as const;
const waitForValues = ["selector", "expression"] as const;
const CHROME_TOOL_NAMES = [
	"chrome_launch",
	"chrome_tab",
	"chrome_snapshot",
	"chrome_navigate",
	"chrome_evaluate",
	"chrome_click",
	"chrome_click_retry",
	"chrome_session_check",
	"chrome_type",
	"chrome_fill",
	"chrome_set_value",
	"chrome_set_native_value",
	"chrome_key",
	"chrome_wait_for",
	"chrome_list_console_messages",
	"chrome_list_network_requests",
	"chrome_get_network_request",
	"chrome_screenshot",
	"chrome_hover",
	"chrome_drag",
	"chrome_tap",
	"chrome_scroll",
	"chrome_upload_file",
	"chrome_credentials_list",
	"chrome_credentials_add",
	"chrome_credentials_remove",
	"chrome_credentials_fill",
] as const;
const CHROME_TOOL_NAME_SET = new Set<string>(CHROME_TOOL_NAMES);

function StringEnum<T extends readonly [string, ...string[]]>(values: T) {
	return Type.Union(values.map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]);
}

export default function (pi: ExtensionAPI): void {
	const instanceToken = Symbol("pi-chrome-instance");
	const currentRoot = extensionRoot();
	const globalState = globalThis as typeof globalThis & {
		[PI_CHROME_GLOBAL_KEY]?: { version: string; root: string; token?: symbol };
		[PI_CHROME_AUTH_KEY]?: { until: number | "indefinite" };
	};
	const alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];
	if (alreadyLoaded?.token || (alreadyLoaded && alreadyLoaded.root !== currentRoot)) {
		console.warn(
			`pi-chrome already loaded from ${alreadyLoaded.root} (v${alreadyLoaded.version}); skipping duplicate from ${currentRoot}.`,
		);
		return;
	}
	// pi-chrome <=0.15.19 set the singleton flag but did not clear it on reload.
	// If the stale flag points at this same extension root, replace it instead of
	// skipping the freshly reloaded extension.
	globalState[PI_CHROME_GLOBAL_KEY] = { version: PI_CHROME_VERSION, root: currentRoot, token: instanceToken };

	const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);
	// Attach the control-plane handler before any /next traffic so the first popup click after
	// omp reload already has the route.
	bridge.onControlRequest = async (url, _request, response) => {
		try {
			if (url.searchParams.get("action") === "doctor") {
				// doctor is async — handle inline so we can await statusSummary().
				try {
					const text = await statusSummary();
					sendJson(response, 200, { ok: true, result: { text } });
				} catch (error) {
					sendJson(response, 500, { ok: false, error: (error as Error).message });
				}
				return true;
			}
			const result = handlePiChromeControlRequest(url);
			sendJson(response, result.status, result.body);
			return true;
		} catch (error) {
			sendJson(response, 500, { ok: false, error: (error as Error).message });
			return true;
		}
	};
	let backgroundEnabled = true;
	let chromeAuthorizedUntil: number | "indefinite" | undefined;
	// Restore an authorization that survived a /reload. Drop it if it already expired.
	const persistedAuth = globalState[PI_CHROME_AUTH_KEY];
	if (persistedAuth) {
		if (persistedAuth.until === "indefinite" || persistedAuth.until > Date.now()) {
			chromeAuthorizedUntil = persistedAuth.until;
		} else {
			delete globalState[PI_CHROME_AUTH_KEY];
		}
	}
	const persistAuth = (): void => {
		if (chromeAuthorizedUntil === undefined) delete globalState[PI_CHROME_AUTH_KEY];
		else globalState[PI_CHROME_AUTH_KEY] = { until: chromeAuthorizedUntil };
	};
	let chromeToolsRegistered = false;
	let chromeToolsUsable = false;
	let authExpiryTimer: NodeJS.Timeout | undefined;
	let countdownInterval: NodeJS.Timeout | undefined;
	// Remembered so bridge sends can tag tabs with this session's group even when ctx isn't handy.
	let sessionCtx: ExtensionContext | undefined;
	// Cache of the most recently observed tab id for this session. Lets page.* tools omit
	// targetId when they only ever work on one tab, mirroring how human users think about
	// "the current tab". Updated from chrome_tab list and from tab.new / tab.activate results.
	// Cleared on session_start and on `bridge.stop()` to avoid carrying stale ids across runs.
	let lastActiveTabId: number | undefined;
	// Timestamp of the most recent successful chrome_snapshot in this session. chrome_click with
	// bare x,y uses this to warn when the viewport may have shifted since the last observation.
	let lastSnapshotAt: number = 0;
	const STALE_SNAPSHOT_MS = 5_000;
	const noteSnapshotTaken = (): void => { lastSnapshotAt = Date.now(); };
	const snapshotIsFresh = (): boolean => Date.now() - lastSnapshotAt < STALE_SNAPSHOT_MS;

	const rememberTabId = (candidate: unknown): void => {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
			lastActiveTabId = candidate;
			return;
		}
		if (candidate && typeof candidate === "object") {
			const obj = candidate as { id?: unknown; tabId?: unknown };
			if (typeof obj.id === "number" && Number.isFinite(obj.id) && obj.id > 0) {
				lastActiveTabId = obj.id;
			} else if (typeof obj.tabId === "number" && Number.isFinite(obj.tabId) && obj.tabId > 0) {
				lastActiveTabId = obj.tabId;
			}
		}
	};

	const clearAuthExpiryTimer = (): void => {
		if (!authExpiryTimer) return;
		clearTimeout(authExpiryTimer);
		authExpiryTimer = undefined;
	};

	const clearCountdownInterval = (): void => {
		if (!countdownInterval) return;
		clearInterval(countdownInterval);
		countdownInterval = undefined;
	};

	const chromeToolsActive = (tools = pi.getActiveTools()): boolean => tools.some((name) => CHROME_TOOL_NAME_SET.has(name));

	const activateChromeTools = (): boolean => {
		registerChromeTools(pi);
		const before = pi.getActiveTools();
		const next = [...new Set([...before, ...CHROME_TOOL_NAMES])];
		pi.setActiveTools(next);
		return !chromeToolsActive(before) && chromeToolsActive(next);
	};

	const deactivateChromeTools = (): boolean => {
		const before = pi.getActiveTools();
		pi.setActiveTools(before.filter((name) => !CHROME_TOOL_NAME_SET.has(name)));
		return chromeToolsActive(before);
	};

	const logChromeToolChange = (
		action: "authorized" | "reauthorized" | "revoked" | "expired",
		options: { label?: string; authorizedUntil?: number | "indefinite" } = {},
	): void => {
		const content = action === "authorized"
			? `Chrome tools enabled by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
			: action === "reauthorized"
				? `Chrome tool authorization updated by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
				: action === "expired"
					? "Chrome tools disabled because /chrome authorize grant expired."
					: "Chrome tools disabled by /chrome revoke.";
		pi.sendMessage({
			customType: "pi-chrome-tool-change",
			content,
			display: true,
			details: {
				action,
				tools: [...CHROME_TOOL_NAMES],
				authorizedUntil: options.authorizedUntil,
				at: Date.now(),
			},
		}, { triggerTurn: false });
	};

	// Bound the entire request, including shared-owner forwarding/takeover. Revoke can launch
	// this in the background; shutdown must wait before tearing down the bridge.
	const cleanupAutomationTargetBestEffort = async (timeoutMs = 2_000): Promise<void> => {
		const sessionKey = sessionKeyFor(sessionCtx);
		if (sessionKey === undefined) return; // Never clean up an unscoped/default session.
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				bridge.send("automation.cleanup", { sessionKey }, timeoutMs, controller.signal).catch(() => undefined),
				new Promise<void>((resolveCleanup) => {
					timer = setTimeout(() => { controller.abort(); resolveCleanup(); }, timeoutMs);
				}),
			]);
		} catch {
			// Shutdown/revoke remains best-effort when Chrome or its bridge is unavailable.
		} finally {
			clearTimeout(timer);
		}
	};

	const lockChromeControl = (logAction?: "revoked" | "expired"): void => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		const wasUsable = chromeToolsUsable;
		deactivateChromeTools();
		chromeToolsUsable = false;
		if (logAction && wasUsable) logChromeToolChange(logAction, { authorizedUntil: undefined });
		chromeAuthorizedUntil = undefined;
		persistAuth();
		// Revoking control ends pi-chrome's automation for this session; tidy up the target we own.
		void cleanupAutomationTargetBestEffort();
	};

	const authSummary = (): string => {
		if (chromeAuthorizedUntil === "indefinite") return "authorized indefinitely";
		if (typeof chromeAuthorizedUntil === "number") {
			const remainingMs = chromeAuthorizedUntil - Date.now();
			if (remainingMs > 0) return `authorized for ~${Math.ceil(remainingMs / 60_000)}m`;
		}
		return "locked";
	};

	const chromeControlAuthorized = (): boolean => {
		if (chromeAuthorizedUntil === "indefinite") return true;
		if (typeof chromeAuthorizedUntil === "number" && chromeAuthorizedUntil > Date.now()) return true;
		if (chromeAuthorizedUntil !== undefined) lockChromeControl("expired");
		return false;
	};

	const requireChromeControlAuthorized = (): void => {
		if (!chromeControlAuthorized()) {
			throw new Error("Chrome control locked. Ask the user to run /chrome authorize before using chrome_* tools.");
		}
	};

	// Tab-group title for this Pi session: prefer the user-set display name, else the session id.
	const sessionGroupTitle = (ctx: ExtensionContext): string => {
		const sm = ctx.sessionManager;
		const name = sm.getSessionName?.();
		const id = sm.getSessionId?.();
		return `Pi Session: ${name || id || "unknown"}`;
	};

	const authCountdownLabel = (): string => {
		if (chromeAuthorizedUntil === "indefinite") return " (indefinite)";
		if (typeof chromeAuthorizedUntil === "number") {
			const remainingMs = chromeAuthorizedUntil - Date.now();
			if (remainingMs > 0) {
				const mins = Math.ceil(remainingMs / 60_000);
				return mins >= 1 ? ` (${mins}m)` : " (<1m)";
			}
		}
		return "";
	};

	// Stable per-session key the service worker uses to scope its dedicated automation tab/window
	// to *this* session (one extension brokers all sessions). The session id is stable across
	// /reload, so the automation target is reused rather than orphaned. Returns undefined only
	// before session_start, in which case the worker uses its default bucket.
	const sessionKeyFor = (ctx: ExtensionContext | undefined): string | undefined => {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? `session:${id}` : undefined;
	};

	const updateChromeStatus = (ctx: ExtensionContext): void => {
		if (chromeControlAuthorized()) {
			ctx.ui.setStatus("chrome", ctx.ui.theme.fg("success", "●") + " Chrome Bridge" + authCountdownLabel());
		} else {
			ctx.ui.setStatus("chrome", undefined);
		}
	};

	// Ticks every 60 s while a timed authorization is active to keep the countdown current.
	const startCountdownTicker = (ctx: ExtensionContext): void => {
		clearCountdownInterval();
		if (chromeAuthorizedUntil === "indefinite" || typeof chromeAuthorizedUntil !== "number") return;
		countdownInterval = setInterval(() => {
			if (!chromeControlAuthorized()) {
				clearCountdownInterval();
				return;
			}
			updateChromeStatus(ctx);
		}, 60_000);
	};

	const scheduleAuthExpiry = (ctx: ExtensionContext, until: number | "indefinite"): void => {
		clearAuthExpiryTimer();
		startCountdownTicker(ctx);
		if (until === "indefinite") return;
		authExpiryTimer = setTimeout(() => {
			if (chromeAuthorizedUntil !== until) return;
			try {
				lockChromeControl("expired");
				ctx.ui.notify("Chrome control authorization expired. Run /chrome authorize to allow chrome_* tools again.", "info");
				updateChromeStatus(ctx);
			} catch (error) {
				console.warn(`Failed to expire pi-chrome authorization cleanly: ${(error as Error).message}`);
			}
		}, Math.max(0, until - Date.now()));
	};

	const authorizedBridgeSend = async (action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> => {
		requireChromeControlAuthorized();
		// credentials.list is a pure Node-side read of the encrypted store — the worker can't
		// read the file, so short-circuit it here to keep the wire-protocol action name stable
		// without ever crossing the bridge.
		if (action === "credentials.list") {
			return credentialsList();
		}
		// Background on is a session policy, not a default that tool arguments can override.
		// Apply it here so tab.new, chrome_launch(url), and tools without a background parameter
		// cannot bypass it. Background off still permits per-call background:true.
		const typed = params as { background?: boolean; foreground?: boolean; targetId?: unknown; urlIncludes?: unknown; titleIncludes?: unknown };
		const requestedBackground = typed.background ?? (typed.foreground !== undefined ? !typed.foreground : false);
		const background = backgroundEnabled || requestedBackground;
		if (action === "tab.activate" && background) {
			throw new Error("Tab activation is blocked by background mode. Ask the user to run /chrome background off to allow foreground work.");
		}
		// Scope every action to this session's dedicated automation target and tab group.
		const sessionKey = sessionKeyFor(sessionCtx);
		let wireParams: Record<string, unknown> = { ...params, background, foreground: !background };
		// page.* actions can omit targetId when the caller is clearly working on a single tab
		// (chrome_tab list, chrome_navigate, explicit chrome_tab activate all populate this cache).
		// urlIncludes/titleIncludes still win because they already disambiguate. Anything that
		// needs a specific tab — tab.activate, tab.close, tab.group — is excluded because the
		// caller must choose explicitly.
		const isPageAction = action.startsWith("page.");
		const callerTargetId = wireParams.targetId;
		const hasExplicitTarget =
			callerTargetId !== undefined && callerTargetId !== null && callerTargetId !== "";
		const hasSelectorTarget = typeof wireParams.urlIncludes === "string" || typeof wireParams.titleIncludes === "string";
		if (isPageAction && !hasExplicitTarget && !hasSelectorTarget && typeof lastActiveTabId === "number") {
			wireParams = { ...wireParams, targetId: lastActiveTabId };
		}
		if (sessionKey !== undefined && params.sessionKey === undefined) wireParams.sessionKey = sessionKey;
		const sessionTitle = sessionCtx !== undefined ? sessionGroupTitle(sessionCtx) : undefined;
		// Any tab Pi opens through tab.new/tab.group must use THIS session's group, even if a caller
		// passes group:false or a custom groupTitle. This central guard covers chrome_tab plus internal
		// callers such as chrome_launch(url).
		if ((action === "tab.new" || action === "tab.group") && sessionTitle !== undefined) {
			wireParams = { ...wireParams, groupTitle: sessionTitle };
		}
		// Any tab Pi *uses* (page.* interactions) should join this session's group, mirroring the
		// auto-grouping that tab.new already does. Tagging the wire params lets getTabByParams pull
		// the resolved tab into the session group on the service-worker side. We skip tab.* actions:
		// tab.new/group are forced above, and activate/close/ungroup/list must not group tabs.
		const shouldJoinGroup = action.startsWith("page.") && sessionTitle !== undefined && params.sessionGroupTitle === undefined;
		if (shouldJoinGroup) {
			wireParams = { ...wireParams, sessionGroupTitle: sessionTitle, joinSessionGroup: true };
		}
		// Older companions ignore background for tab creation and activate tabs for screenshots.
		// Dedicated wire actions make them fail closed, with no probe/action race or extra round trip.
		// These are internal protocol aliases, not new tools or /chrome commands.
		const wireAction = background && (action === "tab.new" || action === "page.screenshot")
			? `${action}.background`
			: action;
		try {
			return await bridge.send(wireAction, wireParams, timeoutMs, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (wireAction !== action && message.includes(`Unknown action: ${wireAction}`)) {
				throw new Error("Hard background requires an updated Chrome companion extension. Reload Pi Chrome Connector at chrome://extensions, then retry.");
			}
			throw error;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		// Stale tab ids from a previous omp run would route page.* to the wrong tab. Drop the
		// cache so the first chrome_tab list / chrome_navigate repopulates it cleanly.
		lastActiveTabId = undefined;
		await bridge.start();
		// Reestablish in-memory state after a /reload restored chromeAuthorizedUntil from globalThis.
		if (chromeControlAuthorized()) {
			activateChromeTools();
			chromeToolsUsable = true;
			if (typeof chromeAuthorizedUntil === "number") scheduleAuthExpiry(ctx, chromeAuthorizedUntil);
			else if (chromeAuthorizedUntil === "indefinite") startCountdownTicker(ctx);
		} else {
			deactivateChromeTools();
			chromeToolsUsable = false;
		}
		updateChromeStatus(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		// /reload continues the same session. On exit, give Chrome a bounded opportunity to
		// close this session's created tabs and ungroup adopted tabs before stopping the broker.
		if (event?.reason !== "reload") await cleanupAutomationTargetBestEffort();
		bridge.stop();
		if (globalState[PI_CHROME_GLOBAL_KEY]?.token === instanceToken) {
			delete globalState[PI_CHROME_GLOBAL_KEY];
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!chromeToolsRegistered || !chromeControlAuthorized()) {
			return { systemPrompt: event.systemPrompt };
		}
		const primer = `
<chrome-profile-bridge>
Chrome control is available through the chrome_* tools via a companion Chrome extension installed in the user's normal Chrome profile. Tools target the existing signed-in profile: no remote-debug port, no throwaway profile.

Tab/window isolation (important):
- pi-chrome owns a dedicated automation window/tab. When a chrome_* tool runs with no explicit target, it acts on that pi-chrome-owned target — it never reuses or overwrites the user's currently active tab. The dedicated target is created on first use and reused afterward.
- To act on a specific *existing* tab (e.g. one the user asks you to use), pass targetId/urlIncludes/titleIncludes. Without one of those, assume you are working in pi-chrome's own automation target.
- pi-chrome's automation target may be closed automatically when Chrome control is revoked; user tabs/windows are never closed by pi-chrome.

Capability model (important):
- Interactive controls (click/type/fill/key/hover/drag/scroll/tap) use Chrome's real input layer via chrome.debugger / CDP. Events satisfy normal user-activation gates.
- Input bypasses page CSP because it is injected at browser input layer, not page JavaScript. Chrome may show the “Pi Chrome Connector started debugging this browser” banner while attached.
- \`chrome_evaluate\` and \`chrome_snapshot\` run in MAIN world via **CDP \`Runtime.evaluate\`**, which is not subject to the page's Content-Security-Policy. They work even on strict-CSP pages (e.g. github.com, many bank/SaaS apps) that block \`'unsafe-eval'\`. \`chrome_navigate initScript\` likewise injects at document_start via CDP and bypasses CSP. \`chrome_screenshot\`, \`chrome_tab\`, and Chrome input also work under any CSP.
- Input tools return structured details and support \`includeSnapshot=true\` on click/type/fill/key. Use the fresh snapshot to verify state instead of repeating blindly.

Usage rules:
1. If a chrome_* tool says Chrome control is locked, ask the user to run \`/chrome authorize\` before retrying.
2. \`chrome_snapshot\` before clicking/typing; pass \`uid\` over \`selector\`.
3. \`includeSnapshot=true\` on click/type/fill/key to verify in one round trip.
4. If \`chrome_evaluate\` returns null when you expected a value, the expression evaluated to null/undefined in the page; surface the value via \`JSON.stringify\` to confirm.
5. \`chrome_navigate\` supports an optional \`initScript\` that runs at document_start in MAIN world for the next navigation (good for seeding localStorage or stubbing Date.now).
6. /chrome background on (default) is a hard policy: per-call \`background=false\` cannot override it, new tabs stay inactive, and \`chrome_tab activate\` is blocked. Ask the user to run /chrome background off when they want foreground/watch mode. With background off, per-call \`background=true\` still avoids explicit focus/tab activation. Screenshots use CDP without activating background tabs; debugger failures never fall back to tab activation. Page scripts, trusted input, native prompts, and Chrome/OS behavior can still affect focus.
7. If you hit a native file-picker or privileged browser prompt gate, tell the user; generic clicks/typing/CSP gates are handled by Chrome input.
8. Run /chrome doctor when in doubt about connectivity or capabilities.
</chrome-profile-bridge>`;
		return { systemPrompt: event.systemPrompt + primer };
	});

	// Shared handlers, dispatched by the unified /chrome command below.
	const doctorHandler = async (ctx: ExtensionContext) => {
			ctx.ui.notify("Checking pi-chrome…", "info");
			const lines: string[] = [
				`pi-chrome v${PI_CHROME_VERSION}`,
				`• Authorization: ${authSummary()}.`,
				`• Background: ${backgroundEnabled ? "on (hard)" : "off (foreground/watch mode)"}.`,
			];
			const status = bridge.status();
			const roleLabel = status.mode === "client" ? "sharing another pi session's connection" : "running the Chrome connection for this machine";
			lines.push(`• This pi session is ${roleLabel}.`);
			let extensionAlive = false;
			let versionMismatch = false;
			try {
				const started = Date.now();
				const version = (await bridge.send("tab.version", {}, 35_000)) as {
					extensionId?: string;
					extensionVersion?: string;
					bridgeUrl?: string;
				};
				const latencyMs = Date.now() - started;
				extensionAlive = true;
				if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
					versionMismatch = true;
					lines.push(
						`✗ The Chrome companion extension is on an old version (${version.extensionVersion}); this pi-chrome is ${PI_CHROME_VERSION}.`,
						`  Every Chrome action will run with the old code until you reload the extension.`,
						`  Fix: open chrome://extensions and click the refresh icon on 'Pi Chrome Connector'.`,
						`  (After this one-time fix, future updates reload automatically.)`,
					);
				} else {
					lines.push(`✓ Chrome is connected (companion extension v${version.extensionVersion ?? "?"}, responded in ${latencyMs}ms).`);
				}
			} catch (error) {
				const message = (error as Error).message;
				lines.push(`✗ Chrome isn't responding: ${message}`);
				if (message.includes("older pi-chrome without multi-session")) {
					lines.push("  Fix: quit and restart the pi session that first opened the Chrome connection (it was on an older pi-chrome).");
				} else {
					lines.push("  Fix: run /chrome onboard to install the Chrome companion extension, then keep that Chrome window open.");
				}
			}

			if (extensionAlive && !versionMismatch) {
				// Sanity-check that pi-chrome can actually run code in the active tab.
				try {
					const value = await bridge.send("page.evaluate", { expression: "1+1", awaitPromise: true, foreground: false }, 10_000);
					if (value === 2) lines.push(`✓ pi-chrome can run code in the active Chrome tab.`);
					else lines.push(`⚠ pi-chrome ran code in the active tab but got an unexpected result (${JSON.stringify(value)}). The current tab may be locked-down (a Chrome internal page or a strict site).`);
				} catch (error) {
					lines.push(`✗ pi-chrome can't run code in the active tab: ${(error as Error).message}`);
				}

				// Surface obvious site-side automation flags so the user knows why a site might block pi.
				try {
					const probe = (await bridge.send("page.probe", { foreground: false }, 10_000)) as Record<string, unknown>;
					if (probe && probe.arithmetic === 2) lines.push(`✓ The active tab is ${hostnameOf(String(probe.location))} and accepts pi-chrome's commands.`);
					if (probe && probe.webdriver) lines.push(`⚠ Your Chrome is reporting itself as automated to websites. Some sites use this signal to block sign-ins or bot checks.`);
				} catch (error) {
					lines.push(`⚠ Couldn't inspect the active tab: ${(error as Error).message}`);
				}
			} else if (versionMismatch) {
				lines.push(`… Skipped the remaining checks until you reload the Chrome extension.`);
			}

		ctx.ui.notify(lines.join("\n"), "info");
	};

	// Existing background setting is the hard policy. No args = toggle; no separate lock mode.
	const BACKGROUND_DESC: Record<string, string> = {
		on: "Hard background: pi-chrome will not explicitly focus windows or activate tabs; per-call foreground overrides and tab activation are blocked. Page/Chrome behavior can still affect focus.",
		off: "Foreground/watch mode: Chrome may come forward and switch tabs. Per-call background:true still avoids explicit focus/tab activation.",
	};

	const backgroundHandler = async (ctx: ExtensionContext, args: string) => {
		const arg = (args || "").trim().toLowerCase();
		const currentLabel = backgroundEnabled ? "on" : "off";

		if (arg === "status") {
			ctx.ui.notify(`Run in background is ${currentLabel}. ${BACKGROUND_DESC[currentLabel]}`, "info");
			return;
		}

		if (arg === "on" || arg === "true" || arg === "1") backgroundEnabled = true;
		else if (arg === "off" || arg === "false" || arg === "0") backgroundEnabled = false;
		else if (arg === "toggle" || arg === "") backgroundEnabled = !backgroundEnabled;
		else {
			ctx.ui.notify(`Unknown background setting '${arg}'. Pick one of: on | off | toggle | status.`, "warning");
			return;
		}

		const nextLabel = backgroundEnabled ? "on" : "off";
		ctx.ui.notify(`Run in background → ${nextLabel}. ${BACKGROUND_DESC[nextLabel]}`, "info");
	};

	const authorizeFor = async (ctx: ExtensionContext, label: string, until: number | "indefinite") => {
		const ok = await ctx.ui.confirm(
			"Authorize pi-chrome control?",
			`This Pi session will be allowed to inspect and control your existing Chrome profile for ${label}.\n\nChrome actions use your signed-in browser state and real input. Only approve if you trust the current agent/task.`,
		);
		if (!ok) {
			ctx.ui.notify("Chrome control remains locked.", "info");
			return;
		}
		const wasUsable = chromeToolsUsable;
		chromeAuthorizedUntil = until;
		persistAuth();
		activateChromeTools();
		chromeToolsUsable = true;
		logChromeToolChange(wasUsable ? "reauthorized" : "authorized", { label, authorizedUntil: until });
		scheduleAuthExpiry(ctx, until);
		ctx.ui.notify(`Chrome control authorized for ${label}.`, "info");
		updateChromeStatus(ctx);
	};

	const parseAuthorizeArg = (arg: string): { label: string; until: number | "indefinite" } | undefined => {
		const normalized = arg.trim().toLowerCase() || "15m";
		if (normalized === "indefinite" || normalized === "forever") return { label: "indefinitely", until: "indefinite" };
		const minutes = normalized.endsWith("m") ? Number(normalized.slice(0, -1)) : Number(normalized);
		if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
		return { label: `${minutes} minutes`, until: Date.now() + minutes * 60_000 };
	};

	const authorizeHandler = async (ctx: ExtensionContext, args: string) => {
		const grant = parseAuthorizeArg(args);
		if (!grant) {
			ctx.ui.notify("Unknown authorize duration. Use minutes (15m, 30m, 45) or indefinite.", "warning");
			return;
		}
		return authorizeFor(ctx, grant.label, grant.until);
	};

	const revokeHandler = (ctx: ExtensionContext) => {
		lockChromeControl("revoked");
		ctx.ui.notify("Chrome control locked. Run /chrome authorize to allow chrome_* tools again.", "info");
		updateChromeStatus(ctx);
	};

	const onboardHandler = async (ctx: ExtensionContext) => {
		const extensionPath = browserExtensionPath();
		const proceed = await ctx.ui.confirm(
			"Install the pi-chrome Chrome extension?",
			`This opens Chrome's extensions page and reveals the folder pi-chrome needs you to load.\n\nWhen the windows open, in Chrome:\n  1. Turn on 'Developer mode' (top-right toggle).\n  2. Click 'Load unpacked' and choose the folder that just opened in Finder, or paste this path:\n     ${extensionPath}\n\nPress Enter to continue, or Esc to cancel.`,
		);
		if (!proceed) {
			ctx.ui.notify("Cancelled. You can run /chrome onboard again whenever you're ready.", "info");
			return;
		}
		if (process.platform === "darwin") {
			await pi.exec("open", ["-a", "Google Chrome", "chrome://extensions"], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("open", ["-R", extensionPath], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("sh", ["-lc", `printf %s ${JSON.stringify(extensionPath)} | pbcopy`], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
		}
		ctx.ui.notify(
			"Chrome and Finder should be open. The extension folder path is on your clipboard. After you click 'Load unpacked' and pick it, run /chrome doctor to confirm everything is connected.",
			"info",
		);
	};

	// Lightweight connection/auth/background header for the bare-/chrome picker. No page probes.
	const statusSummary = async (): Promise<string> => {
		const parts: string[] = [];
		try {
			const version = (await bridge.send("tab.version", {}, 5_000)) as { extensionVersion?: string };
			if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
				parts.push(`⚠ Chrome extension v${version.extensionVersion} (pi-chrome v${PI_CHROME_VERSION}, reload extension)`);
			} else {
				parts.push(`✓ Chrome connected`);
			}
		} catch {
			parts.push(`✗ Chrome not responding`);
		}
		parts.push(`auth: ${authSummary()}`);
		parts.push(`background: ${backgroundEnabled ? "on (hard)" : "off"}`);
		return parts.join(" · ");
	};
	function handlePiChromeControlRequest(url: URL): { status: number; body: Record<string, unknown> } {
		const action = url.searchParams.get("action");
		if (!action) return { status: 404, body: { ok: false, error: "missing action" } };
		switch (action) {
			case "authorize": {
				const duration = url.searchParams.get("duration") ?? "15m";
				const grant = parseAuthorizeArg(duration);
				if (!grant) return { status: 400, body: { ok: false, error: `Unknown duration '${duration}'` } };
				const ctx = sessionCtx;
				if (ctx) void authorizeFor(ctx, grant.label, grant.until);
				else {
					// No live TTY session — write the grant directly so the popup click takes effect.
					chromeAuthorizedUntil = grant.until;
					persistAuth();
				}
				return { status: 200, body: { ok: true, result: { until: chromeAuthorizedUntil, label: grant.label } } };
			}
			case "revoke": {
				lockChromeControl("revoked");
				const ctx = sessionCtx;
				if (ctx) ctx.ui.notify("Chrome control locked by companion popup.", "info");
				return { status: 200, body: { ok: true } };
			}
			case "background": {
				const arg = url.searchParams.get("on");
				if (arg === "true" || arg === "1") backgroundEnabled = true;
				else if (arg === "false" || arg === "0") backgroundEnabled = false;
				else backgroundEnabled = !backgroundEnabled;
				return { status: 200, body: { ok: true, result: { background: backgroundEnabled ? "on" : "off" } } };
			}
			case "status": {
				const isAuthorized = chromeAuthorizedUntil === "indefinite" || (typeof chromeAuthorizedUntil === "number" && chromeAuthorizedUntil > Date.now());
				return { status: 200, body: {
					ok: true,
					result: {
						authorized: isAuthorized,
						authorizedUntil: chromeAuthorizedUntil,
						background: backgroundEnabled ? "on" : "off",
					},
				} };
			}
			default:
				return { status: 400, body: { ok: false, error: `Unknown action '${action}'` } };
		}
	}

	const openAuthorizeMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			const choice = await ctx.ui.select("Authorize Chrome control", [
				"15 minutes",
				"30 minutes",
				"Indefinite",
				"Custom minutes",
			]);
			switch (choice) {
				case "15 minutes": return authorizeHandler(ctx, "15m");
				case "30 minutes": return authorizeHandler(ctx, "30m");
				case "Indefinite": return authorizeHandler(ctx, "indefinite");
				case "Custom minutes": {
					const value = await ctx.ui.input("Authorize for how many minutes?", "45");
					if (!value) continue;
					return authorizeHandler(ctx, value);
				}
			}
		}
	};

	const openBackgroundMenu = async (ctx: ExtensionContext): Promise<void> => {
		const choice = await ctx.ui.select("Background / watch mode", [
			"Use Chrome in background",
			"Use Chrome in foreground",
		]);
		if (!choice) return;
		switch (choice) {
			case "Use Chrome in background": return backgroundHandler(ctx, "on");
			case "Use Chrome in foreground": return backgroundHandler(ctx, "off");
		}
	};

	const openCommandMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			ctx.ui.notify("Checking Chrome connection…", "info");
			const choice = await ctx.ui.select(`pi-chrome\n${await statusSummary()}`, [
				"Authorize Chrome control…",
				"Lock Chrome control",
				"Doctor / troubleshoot",
				"Background / watch mode…",
				"Install / onboard extension",
			]);
			if (!choice) return;
			switch (choice) {
				case "Authorize Chrome control…": await openAuthorizeMenu(ctx); continue;
				case "Lock Chrome control": return revokeHandler(ctx);
				case "Doctor / troubleshoot": return doctorHandler(ctx);
				case "Background / watch mode…": await openBackgroundMenu(ctx); continue;
				case "Install / onboard extension": return onboardHandler(ctx);
			}
		}
	};

	pi.registerCommand("chrome", {
		description:
			"All pi-chrome controls in one place.\n  /chrome authorize [15m|30m|<minutes>|indefinite] — allow this Pi session to use chrome_* tools.\n  /chrome revoke   — lock Chrome control.\n  /chrome doctor   — full health check plus authorization and background state.\n  /chrome onboard  — install the Chrome companion extension.\n  /chrome background [on|off|status|toggle] — enforce no explicit focus/tab activation, or allow foreground/watch mode.\nRun with no arguments for an interactive picker that shows current state.",
		getArgumentCompletions: (prefix) => {
			const raw = prefix;
			const trimmedRight = raw.replace(/\s+$/, "");
			const tokens = trimmedRight ? trimmedRight.split(/\s+/) : [];
			const endsWithSpace = raw.length > 0 && raw !== trimmedRight;
			// Path = completed tokens; partial = the token currently being typed (or "" if cursor sits right after a space).
			const partial = endsWithSpace ? "" : (tokens.pop() ?? "");
			const path = tokens.map((t) => t.toLowerCase());
			const partialLower = partial.toLowerCase();

			// Build candidate set with FULL argument-text values so pi-tui's apply-completion
			// (which replaces the entire argument) lands correctly even for nested paths.
			type Item = { fullValue: string; label: string; description: string };
			let candidates: Item[] = [];
			if (path.length === 0) {
				candidates = [
					{ fullValue: "authorize", label: "authorize", description: "Allow this Pi session to use chrome_* tools." },
					{ fullValue: "revoke", label: "revoke", description: "Lock Chrome control for this Pi session." },
					{ fullValue: "doctor", label: "doctor", description: "Full diagnostics: connection, version, page checks, authorization, and background state." },
					{ fullValue: "onboard", label: "onboard", description: "Install the Chrome companion extension (first-time setup)." },
					{ fullValue: "background", label: "background", description: "Enforce hard background or allow foreground/watch mode." },
				];
			} else if (path[0] === "authorize" && path.length === 1) {
				candidates = [
					{ fullValue: "authorize 15m", label: "15m", description: "Authorize Chrome control for 15 minutes." },
					{ fullValue: "authorize 30m", label: "30m", description: "Authorize Chrome control for 30 minutes." },
					{ fullValue: "authorize indefinite", label: "indefinite", description: "Authorize Chrome control until revoked or Pi exits." },
				];
			} else if (path[0] === "background" && path.length === 1) {
				candidates = [
					{ fullValue: "background on", label: "on", description: "Hard background: block explicit focus/tab activation and per-call foreground overrides. (default)" },
					{ fullValue: "background off", label: "off", description: "Bring Chrome to the front so you can watch." },
					{ fullValue: "background toggle", label: "toggle", description: "Flip whichever way it's currently set." },
					{ fullValue: "background status", label: "status", description: "Show the current setting." },
				];
			}
			if (candidates.length === 0) return null;
			const filtered = candidates.filter((c) => c.label.toLowerCase().startsWith(partialLower));
			if (filtered.length === 0) return null;
			return filtered.map((c) => ({ value: c.fullValue, label: c.label, description: c.description }));
		},
		handler: async (args, ctx) => {
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				await openCommandMenu(ctx);
				return;
			}
			const [head, ...rest] = tokens;
			const subArgs = rest.join(" ");
			switch (head) {
				case "authorize": return authorizeHandler(ctx, subArgs);
				case "revoke": return revokeHandler(ctx);
				case "doctor": return doctorHandler(ctx);
				case "onboard": return onboardHandler(ctx);
				case "background":
					return backgroundHandler(ctx, subArgs);
				case "settings": {
					// Legacy nested form: /chrome settings background ...
					const [setting, ...settingArgs] = rest;
					if (setting === "background") return backgroundHandler(ctx, settingArgs.join(" "));
					ctx.ui.notify(`'/chrome settings' was removed. Use /chrome background directly.`, "warning");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand '${head}'. Run /chrome for current state and controls, or try: /chrome authorize | revoke | doctor | onboard | background.`, "warning");
			}
		},
	});

	function registerChromeTools(pi: ExtensionAPI): void {
		if (chromeToolsRegistered) return;
		chromeToolsRegistered = true;

	pi.registerTool({
		name: "chrome_launch",
		label: "Chrome Bridge Setup",
		description:
			"Start/check the local bridge used by the companion Chrome extension. This does not launch a separate Chrome profile; install the unpacked Chrome extension in your existing Chrome profile to connect.",
		promptSnippet: "Show instructions for connecting Pi to the user's existing Chrome profile via the companion extension.",
		parameters: Type.Object({
			port: Type.Optional(Type.Number({ description: "Ignored. The bundled Chrome extension polls 127.0.0.1:17318." })),
			url: Type.Optional(Type.String({ description: "Optional URL to open in the existing Chrome profile after the extension is connected." })),
			userDataDir: Type.Optional(Type.String({ description: "Ignored. This bridge intentionally uses the user's existing Chrome profile through the companion extension." })),
			useDefaultProfile: Type.Optional(Type.Boolean({ description: "Ignored; existing-profile access comes from the companion Chrome extension." })),
			headless: Type.Optional(Type.Boolean({ description: "Ignored." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			if (params.url && bridge.connected) {
				const result = await authorizedBridgeSend("tab.new", { url: params.url }, DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: `Chrome bridge connected; opened ${params.url}` }], details: { status: bridge.status(), result } };
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Chrome profile bridge is listening at ${bridge.url}.\n\n` +
							`To connect your existing Chrome profile:\n` +
							`1. Open chrome://extensions in the Chrome profile you normally use.\n` +
							`2. Enable Developer mode.\n` +
							`3. Click “Load unpacked”.\n` +
							`4. Select: ${browserExtensionPath()}\n\n` +
							`Status: ${bridge.connected ? "connected" : "waiting for extension"}.`,
					},
				],
				details: { status: bridge.status(), extensionPath: browserExtensionPath() },
			};
		},
	});

	pi.registerTool({
		name: "chrome_tab",
		label: "Chrome Tab",
		description: "List, create, activate, close, group, ungroup, or inspect tabs in the user's existing Chrome profile via the companion extension. New/grouped tabs always use this session's Pi tab group. Background mode keeps new tabs inactive and blocks activate; ask the user to run /chrome background off for foreground/watch mode. activate/close/group/ungroup require a target (targetId/urlIncludes/titleIncludes); with no target they act on this session's pi-chrome automation tab if one exists, and otherwise error rather than touching the user's active tab.",
		promptSnippet: "List/open/activate/close/group existing Chrome tabs through the companion extension.",
		parameters: Type.Object({
			action: StringEnum(tabActionValues),
			url: Type.Optional(Type.String({ description: "URL for action=new." })),
			targetId: Type.Optional(Type.String({ description: "Chrome tab id for activate/close/group/ungroup." })),
			urlIncludes: Type.Optional(Type.String({ description: "Match the target tab by URL substring for activate/close/group/ungroup." })),
			titleIncludes: Type.Optional(Type.String({ description: "Match the target tab by title substring for activate/close/group/ungroup." })),
			group: Type.Optional(Type.Boolean({ description: "Deprecated; ignored. Pi-created tabs always join this session's own tab group." })),
			groupTitle: Type.Optional(Type.String({ description: "Deprecated for action=new/group; ignored so one Pi session uses one tab group ('Pi Session: <name-or-id>')." })),
			groupColor: Type.Optional(Type.String({ description: "Tab group color for action=group/new: grey, blue, red, yellow, green, pink, purple, cyan, or orange. Defaults to blue." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const forwarded = { ...params } as typeof params & { groupTitle?: string };
			// Force every Pi-opened/explicitly-grouped tab into this session's own group,
			// named after the session display name (falling back to the session id). There is
			// intentionally no opt-out: one Pi session should create/use one tab group.
			if (params.action === "new" || params.action === "group") {
				forwarded.groupTitle = sessionGroupTitle(ctx);
			}
			const result = await authorizedBridgeSend(`tab.${params.action}`, forwarded, DEFAULT_TIMEOUT_MS, signal);
			if (params.action === "list") {
				const tabs = result as Array<{ id: number; title: string; url: string; active: boolean; windowId: number; group?: { title?: string } | null }>;
				const text = tabs.map((tab) => `${tab.id}\t${tab.active ? "*" : " "}\t${tab.group?.title ? `[${tab.group.title}] ` : ""}${tab.title || "(untitled)"}\t${tab.url}`).join("\n") || "No tabs.";
				// Refresh lastActiveTabId from the list: prefer the user's actually-active tab,
				// otherwise the first tab in the response so single-tab workflows still resolve.
				const activeTab = tabs.find((tab) => tab.active);
				if (activeTab) rememberTabId(activeTab.id);
				else if (tabs.length > 0) rememberTabId(tabs[0].id);
				return { content: [{ type: "text", text }], details: { tabs, lastActiveTabId } };
			}
			// tab.new / tab.activate / tab.group return a single tab record; remember its id so
			// the next page.* call without targetId lands on the freshly focused tab.
			if (params.action === "new" || params.action === "activate" || params.action === "group") {
				rememberTabId(result);
			}
			return { content: [{ type: "text", text: safeJson(result) }], details: { result: result as Json, lastActiveTabId } };
		},
	});

	pi.registerTool({
		name: "chrome_snapshot",
		label: "Chrome Snapshot",
		description:
			"Inspect a page in the user's existing Chrome profile. Default output is a concise, agent-friendly observation with structural layout/context, stable uids, visible actions, form fields, page hints, and changes since the previous snapshot. Use mode/query/nearUid to zoom instead of dumping the whole page. Background mode (default) blocks explicit focus/tab activation even with background=false. Ask the user to run /chrome background off for foreground/watch mode.",
		promptSnippet: "Observe the current Chrome page: concise summary, structural layout, visible actions, forms, page map, query matches, and stable uids.",
		parameters: Type.Object({
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			query: Type.Optional(Type.String({ description: "Find/rank elements, regions, and text matching this phrase, e.g. 'merge button', 'email error', 'approve PR'." })),
			maxTextChars: Type.Optional(Type.Number({ description: "Max body text chars included in the underlying snapshot. Defaults are smaller for concise modes." })),
			containingText: Type.Optional(Type.String({ description: "Only return elements whose label/text contains this string (case-insensitive). Useful when the page has many controls." })),
			roleFilter: Type.Optional(Type.String({ description: "Only return elements matching this ARIA role or tag name (case-insensitive). e.g. 'button', 'link', 'textbox'." })),
			nearUid: Type.Optional(Type.String({ description: "Sort elements by proximity to this snapshot uid. Useful for finding controls near a known anchor." })),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				{ ...params, maxElements: params.maxElements ?? MAX_ELEMENTS },
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			noteSnapshotTaken();
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_find",
		label: "Chrome Find",
		description:
			"Find elements, page regions, or text on the current Chrome page by query. Returns ranked matches with stable uids and coordinates. This is a focused wrapper around chrome_snapshot({ query }).",
		promptSnippet: "Find matching controls/text/regions in Chrome by natural-language query and return stable uids.",
		parameters: Type.Object({
			query: Type.String({ description: "What to find, e.g. 'merge button', 'email error', 'approve PR', 'search box'." }),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				{ ...params, mode: params.mode || "auto", maxElements: params.maxElements ?? MAX_ELEMENTS },
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_inspect",
		label: "Chrome Inspect Element",
		description:
			"Inspect one snapshot uid or selector deeply: nearby text, nearby actions, form context, ancestors, and suggested click target. Use after chrome_snapshot/chrome_find when you need context around one element.",
		promptSnippet: "Inspect a Chrome snapshot uid deeply for nearby text, form context, and suggested actions.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot/chrome_find." })),
			selector: Type.Optional(Type.String({ description: "CSS selector if uid is unavailable." })),
			scrollIntoView: Type.Optional(Type.Boolean({ description: "If true, scroll the target into view before inspecting. Default false to avoid changing page state." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			try {
				const inspect = await authorizedBridgeSend("page.inspect", params, DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: formatChromeInspect(inspect) }], details: { inspect } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/Unknown action: page\.inspect/i.test(message)) throw error;
				// Compatibility fallback for a loaded Chrome extension service worker that has not
				// been reloaded since chrome_inspect was added. It is less rich than page.inspect,
				// but still gives useful nearby candidates instead of failing the workflow.
				const snapshot = await authorizedBridgeSend(
					"page.snapshot",
					{
						...params,
						mode: "interactive",
						maxElements: MAX_ELEMENTS,
						nearUid: params.uid,
						query: params.selector,
					},
					DEFAULT_TIMEOUT_MS,
					signal,
				);
				const text = `chrome_inspect fallback: loaded Chrome extension does not yet support page.inspect; reload it at chrome://extensions for deep inspect.\n\n${formatChromeSnapshot(snapshot)}`;
				return { content: [{ type: "text", text }], details: { snapshot, fallback: "page.snapshot" } };
			}
		},
	});

	pi.registerTool({
		name: "chrome_navigate",
		label: "Chrome Navigate",
		description:
			"Navigate a Chrome tab to a URL via the companion extension. With no target, navigation goes to pi-chrome's own dedicated automation window/tab — it never replaces the user's active tab. Pass targetId/urlIncludes/titleIncludes only to act on a specific existing tab. Background mode (default) blocks explicit focus/tab activation even with background=false; /chrome background off allows foreground/watch mode. Optionally waits for load completion.",
		promptSnippet: "Navigate a Chrome tab in the user's existing profile.",
		parameters: Type.Object({
			url: Type.String(),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			waitUntilLoad: Type.Optional(Type.Boolean({ default: true })),
			timeoutMs: Type.Optional(Type.Number({ default: 15_000 })),
			initScript: Type.Optional(Type.String({ description: "Optional JavaScript source to run in MAIN world at document_start of the next navigation. Useful for seeding localStorage, stubbing Date.now(), or defining navigator.webdriver=undefined. Requires the companion extension's webNavigation permission." })),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.navigate", params, (params.timeoutMs ?? 15_000) + 2_000, signal);
			// page.navigate returns the resolved tab record; remember its id so subsequent page.*
			// calls without targetId land on the just-navigated tab even if it was the automation
			// target rather than the user's previously-active tab.
			rememberTabId(result);
			return { content: [{ type: "text", text: `Navigated to ${params.url}${params.initScript ? " (with initScript)" : ""}` }], details: { result: result as Json, lastActiveTabId } };
		},
	});

	pi.registerTool({
		name: "chrome_evaluate",
		label: "Chrome Evaluate",
		description:
			"Evaluate JavaScript in an existing Chrome tab through the companion extension. Runs in the page context and returns JSON-serializable values when possible. Background mode (default) blocks explicit focus/tab activation even with background=false; /chrome background off allows foreground/watch mode.",
		promptSnippet: "Evaluate JavaScript in the active Chrome tab through the companion extension.",
		parameters: Type.Object({
			expression: Type.String(),
			awaitPromise: Type.Optional(Type.Boolean({ default: true })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const value = await authorizedBridgeSend("page.evaluate", params, DEFAULT_TIMEOUT_MS, signal);
			const text = value === undefined
				? "undefined"
				: typeof value === "string"
					? value
					: safeJson(value) ?? "undefined";
			return { content: [{ type: "text", text: truncateText(text) }], details: { value: value as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_click",
		label: "Chrome Click",
		description:
			"Click a snapshot uid, CSS selector, or viewport coordinate using Chrome's real input layer. Precedence: uid > selector > x,y. Take a chrome_snapshot first to obtain a uid; bare x,y clicks warn when no recent snapshot exists. Pass includeSnapshot=true to return a fresh snapshot after the click. Optional verifyExpr/verifyAfterMs/verifyRetries poll for an effect after the click (Save-Bubble retry) and re-click up to verifyRetries times if the expression stays falsy.",
		promptSnippet: "Click page elements in Chrome by snapshot uid, selector, or viewport coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot. Prefer uid over selector after taking a snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to click. Prefer uid from chrome_snapshot when available." })),
			x: Type.Optional(Type.Number({ description: "Viewport x coordinate if uid/selector is omitted." })),
			y: Type.Optional(Type.Number({ description: "Viewport y coordinate if uid/selector is omitted." })),
			allowCoordFallback: Type.Optional(Type.Boolean({ default: false, description: "When true, suppress the stale-snapshot warning for bare x,y clicks without a fresh snapshot. Use only when you accept that the viewport may have shifted." })),
			verifyExpr: Type.Optional(Type.String({ description: "CSS selector or JS expression polled after the click to confirm the effect. Truthy = success. Defaults: bare strings are treated as CSS selectors; strings containing ; { ( ) [ = are evaluated as JS. Example: '.save-bubble' or 'document.querySelector(\".saved\")'." })),
			verifyAfterMs: Type.Optional(Type.Number({ default: 0, minimum: 0, maximum: 2000, description: "Total ms to poll verifyExpr for after the click before giving up. Default 0 = single probe with no polling. Capped at 2000." })),
			verifyRetries: Type.Optional(Type.Number({ default: 1, minimum: 0, maximum: 3, description: "Max re-clicks when verifyExpr stays falsy. Each retry waits ~150ms then re-fires the click at the same coordinates. Default 1, max 3." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM-dispatched click if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the click." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const warnings: string[] = [];
			if (params.x !== undefined && params.y !== undefined && !params.uid && !params.selector) {
				if (!snapshotIsFresh() && !params.allowCoordFallback) {
					warnings.push(
						`x,y click without fresh snapshot — viewport may have shifted. Pass uid/selector or set allowCoordFallback=true.`,
					);
				}
			}
			// Save-Bubble retry: the service-worker probes verifyExpr after each click and re-fires
			// up to verifyRetries times if the probe stays falsy. We just forward the params and
			// surface the verification metadata in the result details.
			const raw = await authorizedBridgeSend("page.click", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			const text = summary ? `Clicked ${target} — ${summary}` : `Clicked ${target}`;
			const finalText = warnings.length > 0 ? `${warnings.join("\n")}\n${text}` : text;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, finalText) }], details: { result: raw as Json, warnings } };
		},
	});

	pi.registerTool({
		name: "chrome_click_retry",
		label: "Chrome Click (Retry)",
		description:
			"Click a snapshot uid, CSS selector, or viewport coordinate with automatic retry on stale CDP errors. Wraps chrome_click's full chain (auto-fallback uid-CDP -> selector-CDP -> uid-DOM -> selector-DOM -> native) and re-fires the click up to `retries` times when the bridge throws a stale-tab error (Debugger is not attached / Detached while / Target closed / No tab with id). Useful right after a chrome_tab activate or chrome_navigate where the active target may briefly report a stale handle. Precedence: uid > selector > x,y. Pass includeSnapshot=true to return a fresh snapshot after the click. Optional verifyExpr/verifyAfterMs/verifyRetries provide the same Save-Bubble polling as chrome_click.",
		promptSnippet: "Click page elements in Chrome with stale-CDP retry.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot. Prefer uid over selector after taking a snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to click. Prefer uid from chrome_snapshot when available." })),
			x: Type.Optional(Type.Number({ description: "Viewport x coordinate if uid/selector is omitted." })),
			y: Type.Optional(Type.Number({ description: "Viewport y coordinate if uid/selector is omitted." })),
			allowCoordFallback: Type.Optional(Type.Boolean({ default: false, description: "When true, suppress the stale-snapshot warning for bare x,y clicks without a fresh snapshot." })),
			retries: Type.Optional(Type.Number({ default: 0, minimum: 0, maximum: 5, description: "Max additional retry attempts after the first click when the bridge throws a stale-CDP error. Default 0 = single click. Capped at 5." })),
			delayMs: Type.Optional(Type.Number({ default: 250, minimum: 0, maximum: 5000, description: "Base ms to wait between retry attempts. Default 250. Capped at 5000." })),
			backoff: Type.Optional(Type.String({ description: "Backoff strategy between retry attempts. 'linear' (default) keeps a constant delayMs. 'exponential' grows delayMs by 2x per attempt (capped at 5000)." })),
			verifyExpr: Type.Optional(Type.String({ description: "CSS selector or JS expression polled after the click to confirm the effect. Truthy = success." })),
			verifyAfterMs: Type.Optional(Type.Number({ default: 0, minimum: 0, maximum: 2000, description: "Total ms to poll verifyExpr for after the click before giving up. Capped at 2000." })),
			verifyRetries: Type.Optional(Type.Number({ default: 1, minimum: 0, maximum: 3, description: "Max re-clicks when verifyExpr stays falsy. Default 1, max 3." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM-dispatched click if Chrome's CDP input path is blocked." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the click." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const retriesRaw = Number(params.retries);
			const retries = Number.isFinite(retriesRaw) ? Math.min(Math.max(0, Math.floor(retriesRaw)), 5) : 0;
			const delayRaw = Number(params.delayMs);
			const delayMs = Number.isFinite(delayRaw) ? Math.min(Math.max(0, Math.floor(delayRaw)), 5000) : 250;
			const backoff = params.backoff === "exponential" ? "exponential" : "linear";
			const warnings: string[] = [];
			if (params.x !== undefined && params.y !== undefined && !params.uid && !params.selector) {
				if (!snapshotIsFresh() && !params.allowCoordFallback) {
					warnings.push(
						`x,y click without fresh snapshot — viewport may have shifted. Pass uid/selector or set allowCoordFallback=true.`,
					);
				}
			}
			const raw = (await authorizedBridgeSend(
				"page.click.retry",
				{ ...params, retries, delayMs, backoff },
				DEFAULT_TIMEOUT_MS,
				signal,
			)) as Json;
			let inner: Json = raw;
			if (raw && typeof raw === "object" && !Array.isArray(raw) && "result" in raw) {
				inner = (raw as { result: Json }).result;
			}
			let meta: { attempts?: unknown; lastError?: unknown; totalMs?: unknown; lastSyntheticFallback?: unknown } | null = null;
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				meta = raw as { attempts?: unknown; lastError?: unknown; totalMs?: unknown; lastSyntheticFallback?: unknown };
			}
			const attempts = meta && typeof meta.attempts === "number" ? meta.attempts : undefined;
			const lastError = meta && typeof meta.lastError === "string" ? meta.lastError : undefined;
			const totalMs = meta && typeof meta.totalMs === "number" ? meta.totalMs : undefined;
			const summary = summarizeActionResult(inner);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			const attemptsLabel = typeof attempts === "number" && attempts > 1 ? ` (attempt ${attempts})` : "";
			const text = summary
				? `Clicked ${target}${attemptsLabel} — ${summary}`
				: `Clicked ${target}${attemptsLabel}`;
			const finalText = warnings.length > 0 ? `${warnings.join("\n")}\n${text}` : text;
			return {
				content: [{ type: "text", text: formatIncludedSnapshotText(params.includeSnapshot ? raw : inner, finalText) }],
				details: { result: raw as Json, warnings, attempts, lastError, totalMs },
			};
		},
	});

	pi.registerTool({
		name: "chrome_session_check",
		label: "Chrome Session Check",
		description:
			"Probe the active tab for login/SAML/SSO redirect signatures without performing any interaction. Returns url, title, whether the page looks like a known login portal (Microsoft, Google, GitHub, Auth0, Okta), a suggested action ('auto-relogin' vs 'proceed'), and the document readyState. Pass includeSnapshot=true to also return a fresh chrome_snapshot for downstream actions. Use this before/after long sequences of chrome_click / chrome_fill to detect mid-flow logouts or re-auth challenges.",
		promptSnippet: "Detect login/SSO redirect pages in Chrome.",
		parameters: Type.Object({
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result alongside the probe." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			timeoutMs: Type.Optional(Type.Number({ default: 3000, minimum: 100, maximum: 10000, description: "Probe timeout in ms. Default 3000. Capped at 10000." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = (await authorizedBridgeSend(
				"page.sessionCheck",
				{ ...params },
				DEFAULT_TIMEOUT_MS,
				signal,
			)) as Json;
			let inner: Json = raw;
			if (raw && typeof raw === "object" && !Array.isArray(raw) && "result" in raw && (raw as { result?: Json }).result !== undefined) {
				inner = (raw as { result: Json }).result;
			}
			// Narrow via runtime guards rather than inline-cast member access. Each property is
			// read once with a typeof check, so a malformed bridge payload falls through to the
			// safe default instead of silently producing wrong values.
			let url = "(unknown)";
			let title = "";
			let isLoginPage = false;
			let matchedSignature: string | null = null;
			let cspBlocked = false;
			let documentReady: string | null = null;
			if (inner && typeof inner === "object" && !Array.isArray(inner)) {
				if (typeof (inner as { url?: unknown }).url === "string") {
					url = (inner as { url: string }).url;
				}
				if (typeof (inner as { title?: unknown }).title === "string") {
					title = (inner as { title: string }).title;
				}
				if ((inner as { isLoginPage?: unknown }).isLoginPage === true) {
					isLoginPage = true;
				}
				if (typeof (inner as { matchedSignature?: unknown }).matchedSignature === "string") {
					matchedSignature = (inner as { matchedSignature: string }).matchedSignature;
				}
				if ((inner as { cspBlocked?: unknown }).cspBlocked === true) {
					cspBlocked = true;
				}
				if (typeof (inner as { documentReady?: unknown }).documentReady === "string") {
					documentReady = (inner as { documentReady: string }).documentReady;
				}
			}
			const suggestedAction = isLoginPage ? "auto-relogin" : "proceed";
			const label = isLoginPage
				? `login signature: ${matchedSignature}`
				: cspBlocked
					? "no login detected (CSP blocked read)"
					: "no login signature";
			const text = `Session probe @ ${url} — ${label}; suggestedAction=${suggestedAction}; documentReady=${documentReady ?? "?"}${title ? `; title=${title}` : ""}`;
			return {
				content: [{ type: "text", text: formatIncludedSnapshotText(params.includeSnapshot ? raw : inner, text) }],
				details: {
					result: raw as Json,
					url,
					title,
					isLoginPage,
					matchedSignature,
					suggestedAction,
					documentReady,
					cspBlocked,
				},
			};
		},
	});

	pi.registerTool({
		name: "chrome_type",
		label: "Chrome Type",
		description:
			"Focus an optional snapshot uid or CSS selector, then type using Chrome's real input. Contenteditables use one native text insertion; other fields use key events. Set perCharacter=true for editors needing individual keydown events. On React-controlled inputs, prefer chrome_fill — it routes through the native value setter so React state stays in sync. Pass includeSnapshot=true to verify after typing.",
		promptSnippet: "Type text into Chrome, optionally focusing a snapshot uid or selector first.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to focus before typing." })),
			perCharacter: Type.Optional(Type.Boolean({ default: false, description: "Send individual key events even in contenteditables. Default: one native text insertion for contenteditables; key events for other fields." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after typing." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			pressEnter: Type.Optional(Type.Boolean()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.type", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Typed ${params.text.length} character(s)${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_fill",
		label: "Chrome Fill",
		description:
			"Set the full value of a text input, textarea, or contenteditable using Chrome click/select/delete/type input. The value to insert is passed via the `text` parameter (NOT `value`). On React-controlled inputs, fills the React state via native value setter. Contenteditables use one native text insertion; perCharacter=true retains individual keydown events. Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after filling. Example: chrome_fill({ uid: \"el-7\", text: \"hello@example.com\" }).",
		promptSnippet: "Fill a Chrome form field by snapshot uid or selector, optionally returning a fresh snapshot.",
		parameters: Type.Object({
			text: Type.String({ description: "Text to insert into the field. This is the value parameter; pass it as `text=`, never `value=`. Required." }),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to fill if uid is omitted." })),
			perCharacter: Type.Optional(Type.Boolean({ default: false, description: "Send individual key events even in contenteditables. Default: one native text insertion for contenteditables; key events for other fields." })),
			submit: Type.Optional(Type.Boolean({ description: "If true, press Enter after filling." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM value-setting if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after filling." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.fill", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Filled ${params.text.length} character(s)${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_set_value",
		label: "Chrome Set Value",
		description:
			"Set the value of a text input, textarea, or contenteditable using either React's native value setter (when the element is React-controlled) or Chrome's CDP key path (otherwise). The value is passed via the `value` parameter. Pass verifyExpr to poll for an effect after the write (cap 5 attempts, default 2). Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after setting. Example: chrome_set_value({ uid: \"el-7\", value: \"hello@example.com\" }).",
		promptSnippet: "Set a form field's value via React native setter or CDP keys, with optional verify polling.",
		parameters: Type.Object({
			value: Type.String({ description: "Value to assign. Required." }),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to set if uid is omitted." })),
			verifyExpr: Type.Optional(Type.String({ description: "CSS selector or JS expression polled after the write to confirm the effect. Truthy = success. Defaults: bare strings are treated as CSS selectors; strings containing ; { ( ) [ = are evaluated as JS." })),
			verifyAfterMs: Type.Optional(Type.Number({ default: 0, minimum: 0, maximum: 2000, description: "Total ms to poll verifyExpr for after the write before giving up. Default 0 = single probe with no polling. Capped at 2000." })),
			verifyRetries: Type.Optional(Type.Number({ default: 2, minimum: 0, maximum: 5, description: "Max re-writes when verifyExpr stays falsy. Each retry waits ~150ms then re-applies the value. Default 2, max 5." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM value-setting if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after setting." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			// Cap verifyRetries at 5 with default 2 (wire-protocol will also cap).
			const retriesRequested = typeof params.verifyRetries === "number" ? params.verifyRetries : 2;
			const verifyRetries = Math.max(0, Math.min(5, retriesRequested));
			const forwarded = { ...params, verifyRetries };
			const raw = await authorizedBridgeSend("page.setValue", forwarded, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Set value (${params.value.length} char(s))${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_set_native_value",
		label: "Chrome Set Native Value",
		description:
			"Set the value of a text input, textarea, or contenteditable using the native value setter (works for both React-controlled and plain inputs). Detects React-controlled targets via the __reactFiber$/__reactProps$ markers, then routes through reactCompatFill so React's onChange sees the write. The value is passed via the `value` parameter. No key events, no verify polling. Accepts a snapshot uid or CSS selector. Example: chrome_set_native_value({ uid: \"el-7\", value: \"hello@example.com\" }).",
		promptSnippet: "Set a form field's value via the native value setter (React-safe), without key events or verify polling.",
		parameters: Type.Object({
			value: Type.String({ description: "Value to assign via the native value setter. Required." }),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to set if uid is omitted." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM value-setting if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after setting." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.setNativeValue", params, DEFAULT_TIMEOUT_MS, signal);
			const rawRecord = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
			const result: Json = params.includeSnapshot && rawRecord && "result" in rawRecord ? (rawRecord.result as Json) : (raw as Json);
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Set native value (${params.value.length} char(s))${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_key",
		label: "Chrome Key",
		description:
			"Send a keyboard key to an existing Chrome tab (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, or one character). Background mode (default) blocks explicit focus/tab activation even with background=false; /chrome background off allows foreground/watch mode. Pass includeSnapshot=true to verify after the keypress.",
		promptSnippet: "Press keys in Chrome through the companion extension.",
		parameters: Type.Object({
			key: Type.String(),
			modifiers: Type.Optional(Type.Object({
				shiftKey: Type.Optional(Type.Boolean()),
				ctrlKey: Type.Optional(Type.Boolean()),
				altKey: Type.Optional(Type.Boolean()),
				metaKey: Type.Optional(Type.Boolean()),
			}, { description: "Modifier keys to hold while pressing the key. Shift alone types the shifted US-layout character (a → A, 1 → !); Ctrl/Meta/Alt chords do not insert literal text." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the keypress." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.key", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const base = `Pressed ${params.key}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_wait_for",
		label: "Chrome Wait For",
		description: "Poll an existing Chrome tab until a selector exists or a JavaScript expression returns truthy. The `value` field carries BOTH the CSS selector (when kind=selector) AND the JavaScript expression (when kind=expression) — do NOT use a separate `expression` parameter; always pass it as `value=`. With kind=selector the match is filtered by visibility (offsetParent + opacity + display + visibility); waitForStable additionally requires the matched element's rect/opacity to remain unchanged across 2 RAFs + waitForStable ms; waitForSelectorCount requires at least N matching elements to satisfy; includeSnapshot='auto' returns a fresh snapshot iff the wait completed successfully. Examples: chrome_wait_for({ kind: \"selector\", value: \"#submit-btn:not([disabled])\" }) and chrome_wait_for({ kind: \"expression\", value: \"document.querySelectorAll('.row').length >= 5\" }).",
		promptSnippet: "Wait for page state in Chrome before further automation.",
		parameters: Type.Object({
			kind: StringEnum(waitForValues),
			value: Type.String({ description: "The CSS selector OR the JavaScript expression to evaluate, depending on `kind`. Used for both kinds; do NOT use a separate `expression` field." }),
			timeoutMs: Type.Optional(Type.Number({ default: 10_000 })),
			intervalMs: Type.Optional(Type.Number({ default: 250 })),
			waitForVisible: Type.Optional(Type.Boolean({ default: true, description: "When kind=selector, only count matches whose offsetParent is non-null and whose computed opacity > 0, display != 'none', visibility != 'hidden'. Default true." })),
			waitForStable: Type.Optional(Type.Number({ default: 0, description: "After the first visible match, sample rect+opacity across 2 RAFs + this many ms of stable time. 0 disables." })),
			waitForSelectorCount: Type.Optional(Type.Number({ default: 1, description: "Minimum number of selector matches required (after visibility filtering) for the wait to succeed." })),
			includeSnapshot: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")], { description: "Pass true for an unconditional post-wait snapshot, or 'auto' for a snapshot only when the wait found the target. Default false." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.waitFor", params, (params.timeoutMs ?? 10_000) + 2_000, signal);
			let resultObj: unknown = result;
			if (result && typeof result === "object" && "result" in result) {
				resultObj = (result as { result: unknown }).result;
			}
			return { content: [{ type: "text", text: `Observed ${params.kind}: ${params.value}` }], details: { result: resultObj as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_console_messages",
		label: "Chrome Console Messages",
		description:
			"List console messages captured in the page by the companion extension. Capture starts after any chrome_snapshot, chrome_evaluate, chrome_list_console_messages, or chrome_list_network_requests call installs page instrumentation.",
		promptSnippet: "List captured console messages from the active Chrome page.",
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured console log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.console.list", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_network_requests",
		label: "Chrome Network Requests",
		description:
			"List fetch/XMLHttpRequest activity captured in the page by the companion extension. Capture starts after instrumentation is installed by snapshot/evaluate/network/console tools; browser document/static asset requests are not captured. Use includePreservedRequests=true to keep requests from earlier same-tab navigations that were captured before navigation.",
		promptSnippet: "List captured XHR/fetch requests from the active Chrome page before doing DOM-heavy debugging.",
		parameters: Type.Object({
			includePreservedRequests: Type.Optional(Type.Boolean({ description: "Include captured requests from earlier locations in the same tab/session." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured request log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.list", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_get_network_request",
		label: "Chrome Network Request",
		description: "Retrieve one captured fetch/XMLHttpRequest entry, including response body when available, by requestId from chrome_list_network_requests.",
		promptSnippet: "Fetch captured request details and response body by requestId.",
		parameters: Type.Object({
			requestId: Type.String({ description: "Request id returned by chrome_list_network_requests." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.get", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_screenshot",
		label: "Chrome Screenshot",
		description:
			"Capture a screenshot of a Chrome tab via CDP and save it to disk without activating background tabs. Requires debugger access; failures never fall back to activating a tab. Background mode (default) ignores background=false; /chrome background off allows foreground/watch mode.",
		promptSnippet: "Capture Chrome screenshots and save them under .pi/chrome-screenshots by default.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output path. Defaults to .pi/chrome-screenshots/<timestamp>.<format>." })),
			format: Type.Optional(StringEnum(imageFormatValues)),
			quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "JPEG quality 0-100." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture full-page tiles plus a JSON manifest. Temporarily scrolls the target page; does not activate background tabs." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
			const format = params.format ?? "png";
			const cwd = workspaceCwd(ctx);
			const defaultPath = join(cwd, ".pi", "chrome-screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`);
			const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
			const result = (await authorizedBridgeSend("page.screenshot", params, params.fullPage ? 120_000 : DEFAULT_TIMEOUT_MS, signal)) as {
				dataUrl?: string;
				method?: string;
				tab?: unknown;
				fullPage?: boolean;
				dimensions?: { width: number; height: number; viewportHeight: number; dpr: number };
				tiles?: Array<{ y: number; dataUrl: string }>;
			};
			await mkdir(dirname(outputPath), { recursive: true });
			if (result.fullPage && result.tiles && result.dimensions) {
				// Stitch via PNG if format is png; otherwise we fall back to writing tile files and a
				// manifest. We avoid pulling in an image library by writing each tile next to the main
				// path with a -tileN suffix and a stitched.json manifest.
				const { width, height, viewportHeight, dpr } = result.dimensions;
				const manifest: Array<{ path: string; y: number }> = [];
				for (let i = 0; i < result.tiles.length; i++) {
					const tile = result.tiles[i];
					const tilePath = outputPath.replace(/(\.[^.]+)$/, `-tile${i}$1`);
					const base64 = tile.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
					await writeFile(tilePath, Buffer.from(base64, "base64"));
					manifest.push({ path: tilePath, y: tile.y });
				}
				await writeFile(outputPath + ".json", JSON.stringify({ width, height, viewportHeight, dpr, tiles: manifest }, null, 2));
				return {
					content: [{ type: "text", text: `Saved ${result.tiles.length} full-page tile(s) for ${width}×${height}px page. Manifest: ${outputPath}.json` }],
					details: { manifest: outputPath + ".json", tiles: manifest, dimensions: result.dimensions, tab: result.tab, method: result.method } as unknown as Record<string, unknown>,
				};
			}
			if (!result.dataUrl) throw new Error("Screenshot returned no dataUrl");
			const base64 = result.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
			await writeFile(outputPath, Buffer.from(base64, "base64"));
			return { content: [{ type: "text", text: `Saved Chrome screenshot to ${outputPath}` }], details: { path: outputPath, format, tab: result.tab, method: result.method } };
		},
	});

	pi.registerTool({
		name: "chrome_hover",
		label: "Chrome Hover",
		description: "Hover over an element by uid, selector, or x/y using Chrome pointer movement.",
		promptSnippet: "Hover a Chrome element to trigger :hover / mouseover handlers.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.hover", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Hovered ${params.uid ?? params.selector ?? `${params.x},${params.y}`}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_drag",
		label: "Chrome Drag",
		description: "Drag from one uid/selector/point to another using Chrome pointer input.",
		promptSnippet: "Drag a Chrome element from one point to another.",
		parameters: Type.Object({
			fromUid: Type.Optional(Type.String()),
			fromSelector: Type.Optional(Type.String()),
			fromX: Type.Optional(Type.Number()),
			fromY: Type.Optional(Type.Number()),
			toUid: Type.Optional(Type.String()),
			toSelector: Type.Optional(Type.String()),
			toX: Type.Optional(Type.Number()),
			toY: Type.Optional(Type.Number()),
			steps: Type.Optional(Type.Number({ default: 12 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.drag", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Dragged from ${params.fromUid ?? params.fromSelector} to ${params.toUid ?? params.toSelector}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_tap",
		label: "Chrome Tap (Touch)",
		description:
			"Dispatch a real touchstart/touchend tap through Chrome's input layer. Use for sites that gate on TouchEvent rather than MouseEvent (mobile-first PWAs, swipe carousels). Chrome may show its debugging banner while attached.",
		promptSnippet: "Tap (real touch) a Chrome element by snapshot uid, selector, or coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.tap", params, DEFAULT_TIMEOUT_MS, signal);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			return { content: [{ type: "text", text: `Tapped ${target} (touch)` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_scroll",
		label: "Chrome Scroll",
		description: "Scroll the page or a specific scrollable element by dispatching real wheel events with momentum-shaped deltas, then applying the scroll. Positive deltaY scrolls down. Pass uid/selector to scroll within a container, otherwise the document scrolls.",
		promptSnippet: "Scroll a Chrome page or container via wheel events (not raw scrollTop).",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			deltaY: Type.Optional(Type.Number({ description: "Pixels to scroll vertically. Positive = down." })),
			deltaX: Type.Optional(Type.Number({ description: "Pixels to scroll horizontally. Positive = right." })),
			steps: Type.Optional(Type.Number({ description: "Number of wheel events to dispatch. Defaults to ceil(|deltaY|/100)." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.scroll", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Scrolled dy=${params.deltaY ?? 0} dx=${params.deltaX ?? 0}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_upload_file",
		label: "Chrome Upload File",
		description: "Attach local files to a Chrome <input type=file> element using Chrome DevTools file-input control. Does NOT open the native file picker; works with React/Vue/Angular controlled inputs.",
		promptSnippet: "Attach local files to a Chrome <input type=file> without opening the native file picker.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			paths: Type.Array(Type.String(), { description: "Local absolute file paths to upload." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const cwd = workspaceCwd(ctx);
			const paths = params.paths.map((p) => resolve(cwd, p));
			const result = await authorizedBridgeSend("page.upload", { ...params, paths }, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Uploaded ${paths.length} file(s) to ${params.uid ?? params.selector}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_credentials_list",
		label: "Chrome Credentials List",
		description: "List saved login aliases stored in the encrypted ~/.pi-chrome/credentials.json store. Returns name, host, and lastUsedAt. Passwords are never returned; use chrome_credentials_fill to type them into a login form.",
		promptSnippet: "List saved login aliases (no passwords exposed).",
		parameters: Type.Object({}),
		async execute(): Promise<ToolTextResult> {
			requireChromeControlAuthorized();
			const result = await credentialsList();
			return { content: [{ type: "text", text: safeJson(result) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_credentials_add",
		label: "Chrome Credentials Add",
		description: "Add or update a saved login alias in the encrypted ~/.pi-chrome/credentials.json store. The password is encrypted with AES-256-GCM (scrypt-derived key) before being written. The alias is bound to a specific host; chrome_credentials_fill refuses to fill it on any other host. The passphrase is held in keytar/libsecret when available, else a chmod-600 file under ~/.pi-chrome/.",
		promptSnippet: "Encrypt and store a username/password under an alias bound to one host.",
		parameters: Type.Object({
			name: Type.String({ description: "Alias name to reference this credential with later (e.g. 'github')." }),
			host: Type.String({ description: "Hostname this alias is allowed to fill on (e.g. 'github.com'). Lowercased before storage." }),
			username: Type.String(),
			password: Type.String(),
		}),
		async execute(_id, params): Promise<ToolTextResult> {
			requireChromeControlAuthorized();
			const result = await credentialsAdd(params as { name: string; host: string; username: string; password: string });
			return { content: [{ type: "text", text: `Saved alias '${result.name}' for host ${result.host}.` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_credentials_remove",
		label: "Chrome Credentials Remove",
		description: "Remove a saved alias from the encrypted ~/.pi-chrome/credentials.json store. Idempotent: returns removed=false if no such alias.",
		promptSnippet: "Delete a saved alias.",
		parameters: Type.Object({
			name: Type.String(),
		}),
		async execute(_id, params): Promise<ToolTextResult> {
			requireChromeControlAuthorized();
			const result = await credentialsRemove(String(params.name || ""));
			return { content: [{ type: "text", text: result.removed ? `Removed alias '${params.name}'.` : `No alias named '${params.name}'.` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_credentials_fill",
		label: "Chrome Credentials Fill (Auto-relogin)",
		description: "Decrypt the alias's password and type the username then password into the current Chrome tab using chrome_type. Refuses if the active tab's host does not match the alias's bound host. Stops with an error if a TOTP field or hCaptcha/reCAPTCHA iframe is detected (no automatic solving). Rate-limited to 5 attempts per alias per hour. Appends an entry to ~/.pi-chrome/credentials.audit.log on every attempt.",
		promptSnippet: "Auto-fill saved username + password into the active tab.",
		parameters: Type.Object({
			alias: Type.String({ description: "Alias to fill (must match an entry returned by chrome_credentials_list)." }),
			host: Type.String({ description: "Hostname the active tab must match (cross-host guard)." }),
			targetId: Type.Optional(Type.String()),
			usernameUid: Type.Optional(Type.String({ description: "Snapshot uid for the username field. Recommended over selectors." })),
			usernameSelector: Type.Optional(Type.String()),
			passwordUid: Type.Optional(Type.String({ description: "Snapshot uid for the password field." })),
			passwordSelector: Type.Optional(Type.String()),
			submitSelector: Type.Optional(Type.String({ description: "Optional submit button selector to click after typing." })),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			requireChromeControlAuthorized();
			const host = String(params.host || "").toLowerCase();
			if (!host) throw new Error("chrome_credentials_fill: host is required");
			const tabId = params.targetId ? Number(params.targetId) : undefined;
			const result = await credentialsFill({
				alias: String(params.alias || ""),
				host,
				tabId,
				usernameUid: params.usernameUid ? String(params.usernameUid) : undefined,
				usernameSelector: params.usernameSelector ? String(params.usernameSelector) : undefined,
				passwordUid: params.passwordUid ? String(params.passwordUid) : undefined,
				passwordSelector: params.passwordSelector ? String(params.passwordSelector) : undefined,
				submitSelector: params.submitSelector ? String(params.submitSelector) : undefined,
				background: params.background,
				send: (action, p, timeoutMs) => authorizedBridgeSend(action, p, timeoutMs ?? DEFAULT_TIMEOUT_MS, signal),
			});
			const rateLimitRemaining = result && typeof result === "object" && "rateLimitRemaining" in result && typeof result.rateLimitRemaining === "number"
				? result.rateLimitRemaining
				: "?";
			return { content: [{ type: "text", text: `Filled alias '${params.alias}' on ${host} (rate-limit remaining: ${rateLimitRemaining}).` }], details: { result: result as Json } };
		},
	});
	}

}
