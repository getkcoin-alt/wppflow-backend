#!/bin/sh
# entrypoint.sh — start a virtual X display then launch the Node server
# Chromium needs a display even in headless mode on Railway (no real display available).

set -e

echo "[entrypoint] Starting Xvfb virtual display on :99"
Xvfb :99 -screen 0 1280x720x24 -ac &
XVFB_PID=$!

# Give Xvfb a moment to initialise
sleep 1

echo "[entrypoint] Xvfb running (pid $XVFB_PID), starting WppFlow Node server..."
exec node src/server.js
