# Calibration profiles

Benchmark results depend on Chrome profile, OS, input device, and extension mode.
Record these with every run:

- OS and version
- Chrome version
- pi-chrome package version
- companion extension version
- trusted mode: off / auto / on
- input hardware: trackpad vs detent mouse, touch support
- permissions: clipboard, fullscreen, downloads
- viewport size and deviceScaleFactor
- loaded privacy/security extensions

Known environment-sensitive areas:

- WebGL fingerprint can warn/fail in VMs, remote desktops, GPU-disabled Chrome.
- Scroll momentum expects trackpad-like decay; detent mouse wheels may fail manually.
- Touch tests require touch events enabled/supported.
- Dialog/download/file-picker tests require native browser UI handling or manual intervention.
- Stack traces vary across Chrome versions; tests should only fail concrete automation URLs/Runtime frames.
