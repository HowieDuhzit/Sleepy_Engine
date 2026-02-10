#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/animations
chmod -R 777 /app/animations 2>/dev/null || true
mkdir -p /app/config
chmod -R 777 /app/config 2>/dev/null || true
mkdir -p /tmp/nginx/body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

# Generate runtime.json with WebSocket URL from environment
WS_URL="${PUBLIC_WS_URL:-}"
if [ -z "$WS_URL" ]; then
  # Fallback to default if not set
  WS_URL="ws://localhost:2567"
fi

# Convert http/https to ws/wss
WS_URL=$(echo "$WS_URL" | sed 's|^http://|ws://|' | sed 's|^https://|wss://|')

# Write runtime config
cat > /app/config/runtime.json <<EOF
{
  "wsUrl": "$WS_URL"
}
EOF

echo "WebSocket URL configured: $WS_URL"

node /app/server/dist/index.js &

nginx -g 'daemon off;'
