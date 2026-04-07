#!/bin/bash
set -e

echo "[warp] Starting Cloudflare WARP daemon..."
warp-svc &

# Wait for daemon to be ready
sleep 3

echo "[warp] Registering WARP client..."
warp-cli --accept-tos registration new || echo "[warp] Already registered"

echo "[warp] Setting WARP to proxy mode..."
warp-cli --accept-tos mode proxy

echo "[warp] Connecting..."
warp-cli --accept-tos connect

# Wait for connection
sleep 2

# Verify WARP is working
echo "[warp] Checking WARP status..."
warp-cli --accept-tos status || true

echo "[warp] WARP proxy available at socks5://127.0.0.1:40000"
echo "[server] Starting yt-dlp service..."

# Set proxy env for yt-dlp to use WARP
export PROXY_URL="socks5://127.0.0.1:40000"

exec node server.js
