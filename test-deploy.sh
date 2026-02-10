#!/usr/bin/env bash
set -euo pipefail

echo "🧪 Testing TrashyGame deployment locally..."
echo ""

# Clean up any existing containers
echo "📦 Cleaning up existing containers..."
docker compose down -v 2>/dev/null || true

# Build and start
echo "🏗️  Building and starting services..."
export SERVICE_FQDN_APP_80="http://localhost"
docker compose up --build -d

# Wait for services to be healthy
echo "⏳ Waiting for services to be healthy..."
sleep 5

MAX_RETRIES=30
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
  if docker compose ps | grep -q "healthy"; then
    echo "✅ Services are healthy!"
    break
  fi
  RETRY=$((RETRY + 1))
  echo "   Attempt $RETRY/$MAX_RETRIES..."
  sleep 2
done

if [ $RETRY -eq $MAX_RETRIES ]; then
  echo "❌ Services did not become healthy in time"
  docker compose logs
  exit 1
fi

# Test endpoints
echo ""
echo "🔍 Testing endpoints..."
echo ""

# Test nginx is serving the client
echo "1. Testing client (nginx)..."
if curl -sf http://localhost/index.html > /dev/null; then
  echo "   ✅ Client is accessible"
else
  echo "   ❌ Client is not accessible"
  docker compose logs app
  exit 1
fi

# Test runtime config
echo "2. Testing runtime config..."
RUNTIME=$(curl -sf http://localhost/config/runtime.json)
echo "   Runtime config: $RUNTIME"
if echo "$RUNTIME" | grep -q "wsUrl"; then
  echo "   ✅ Runtime config is valid"
else
  echo "   ❌ Runtime config is invalid"
  exit 1
fi

# Test game server API
echo "3. Testing game server API..."
if curl -sf http://localhost/api/animations > /dev/null; then
  echo "   ✅ Game server API is accessible"
else
  echo "   ❌ Game server API is not accessible"
  docker compose logs app
  exit 1
fi

echo ""
echo "🎉 All tests passed!"
echo ""
echo "📊 Service status:"
docker compose ps
echo ""
echo "🌐 Open your browser to: http://localhost"
echo ""
echo "To view logs: docker compose logs -f"
echo "To stop: docker compose down"
echo ""
