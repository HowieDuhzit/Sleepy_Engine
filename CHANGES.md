# Simplified Coolify Deployment

## What Changed

**Simplified WebSocket connection:**
- Client now connects to same domain it's served from (no port, no config needed)
- Removed runtime.json complexity
- Auto-detects wss:// vs ws:// based on page protocol

**Simplified Docker setup:**
- Nginx listens on port 80 (standard)
- Proxies WebSocket/API to internal port 2567
- No environment variables needed

**Files:**
- `docker-compose.coolify.yml` - Use this for Coolify
- `docker-compose.yml` - Use this for local dev
- `COOLIFY.md` - Simple deployment guide

## Deploy to Coolify

1. New Resource → Docker Compose
2. Repository: your repo
3. **Compose file:** `docker-compose.coolify.yml`
4. Assign domain
5. Deploy

Done! No config needed.

## Test Locally

```bash
./test-deploy.sh
```

Open: http://localhost:5173
