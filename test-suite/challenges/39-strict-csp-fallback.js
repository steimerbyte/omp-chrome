Challenge.init({ id: "strict-csp-fallback", instructions: "use screenshot/coordinates; click CSP TARGET" });

const btn = document.getElementById("cspTarget");
btn.style.cssText = [
  "position:fixed",
  "left:220px",
  "top:220px",
  "width:180px",
  "height:72px",
  "font:700 16px system-ui",
  "background:#1f7a1f",
  "color:white",
  "border:0",
  "border-radius:10px",
  "box-shadow:0 0 0 4px rgba(31,122,31,.25)"
].join(";");

document.getElementById("cspTarget").addEventListener("click", (e) => {
  const r = btn.getBoundingClientRect();
  const bad = [];
  if (!e.isTrusted) bad.push("click isTrusted=false");
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
    bad.push(`click coordinates ${e.clientX},${e.clientY} outside target rect ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
  }
  if (bad.length) Challenge.fail(...bad);
  else Challenge.pass("strict CSP page completed via trusted viewport click");
});
