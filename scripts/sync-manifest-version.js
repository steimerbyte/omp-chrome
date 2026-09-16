#!/usr/bin/env node
// Sync browser-extension/manifest.json version from package.json.
// Run automatically by the `version` npm lifecycle hook (npm version <bump>),
// and pre-publish, so the Chrome extension version never drifts from the npm
// package version.
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const pkgPath = join(__dirname, "..", "package.json");
const manifestPath = join(
	__dirname,
	"..",
	"extensions",
	"chrome-profile-bridge",
	"browser-extension",
	"manifest.json",
);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.version === pkg.version) {
	console.log(`manifest.json already at ${pkg.version}`);
	process.exit(0);
}

const prev = manifest.version;
manifest.version = pkg.version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest.json ${prev} -> ${pkg.version}`);

// Stage so `npm version` includes manifest bump in the version commit.
try {
	require("node:child_process").execSync(`git add "${manifestPath}"`, { stdio: "ignore" });
} catch {
	/* not in a git checkout - ok */
}
