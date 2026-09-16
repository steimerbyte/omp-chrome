#!/usr/bin/env bash
# Serve the test suite on a fixed local port so pi-chrome can drive it.
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
echo "serving http://127.0.0.1:${PORT}/"
exec python3 -m http.server "${PORT}" --bind 127.0.0.1
