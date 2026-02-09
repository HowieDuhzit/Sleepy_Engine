#!/usr/bin/env bash
set -euo pipefail

node /app/server/dist/index.js &

nginx -g 'daemon off;'
