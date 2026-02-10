#!/usr/bin/env bash
set -euo pipefail

# Create required directories
mkdir -p /app/animations /app/config /app/data
mkdir -p /tmp/nginx/body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

# Start game server in background
node /app/server/dist/index.js &

# Start nginx in foreground
nginx -g 'daemon off;'
