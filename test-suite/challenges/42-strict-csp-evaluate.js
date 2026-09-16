Challenge.init({
  id: "strict-csp-evaluate",
  instructions: "under strict CSP: read window.__cspToken via chrome_evaluate, type it into the field, click Verify",
});

// Secret available only via JS evaluation. It is intentionally NOT rendered into the DOM and
// is defined non-enumerable, so the only way to obtain it is to evaluate window.__cspToken in
// the page (which proves chrome_evaluate works despite script-src 'self' blocking eval).
const token = "csp-" + Math.random().toString(36).slice(2, 10);
Object.defineProperty(window, "__cspToken", { value: token, enumerable: false, configurable: false, writable: false });

document.getElementById("verify").addEventListener("click", (e) => {
  const bad = [];
  if (!e.isTrusted) bad.push("verify click isTrusted=false (use trusted/CDP input)");
  const val = (document.getElementById("tokenInput").value || "").trim();
  if (val !== token) {
    bad.push(`token mismatch: got "${val}" expected "${token}" — chrome_evaluate must read window.__cspToken under strict CSP`);
  }
  if (bad.length) Challenge.fail(...bad);
  else Challenge.pass("strict CSP: chrome_evaluate read the hidden token via CDP and trusted input submitted it");
});
