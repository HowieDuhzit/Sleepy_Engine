#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/animations
chmod -R u+rwX /app/animations 2>/dev/null || true
mkdir -p /tmp/nginx/body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

node /app/server/dist/index.js &

nginx -g 'daemon off;'
