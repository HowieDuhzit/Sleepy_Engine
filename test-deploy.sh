#!/usr/bin/env bash
set -euo pipefail

echo "🧪 Testing local deployment..."

docker compose down -v 2>/dev/null || true

echo "🏗️  Building..."
docker compose up --build -d

echo "⏳ Waiting for service..."
sleep 5

if curl -sf http://localhost:5173/ > /dev/null; then
  echo "✅ Service is up!"
  echo ""
  echo "🌐 Open: http://localhost:5173"
  echo "📊 Logs: docker compose logs -f"
  echo "🛑 Stop: docker compose down"
else
  echo "❌ Service failed"
  docker compose logs
  exit 1
fi
