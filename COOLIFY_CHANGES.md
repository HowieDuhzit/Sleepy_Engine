# Coolify Deployment Changes

This document summarizes all changes made to enable Coolify deployment.

## Files Modified

### 1. `docker-compose.yml`
**Changes:**
- Changed port mapping from `5175:8080` to `80:8080` (Coolify standard)
- Removed port `2567` exposure (handled internally by nginx proxy)
- Added `PUBLIC_WS_URL=${SERVICE_FQDN_APP_80}` environment variable
- Replaced local volume mounts with named volumes (`animations-data`, `config-data`)
- Added healthcheck configuration
- Added `coolify.managed=true` label

**Why:**
- Coolify expects port 80 for web services
- Magic variable `SERVICE_FQDN_APP_80` auto-populates with assigned domain
- Named volumes persist data across deployments
- Healthchecks enable Coolify monitoring

### 2. `Dockerfile`
**Changes:**
- Added `curl` package installation in `allinone` target
- Added `RUN chmod +x /start.sh` to make start script executable
- Changed `EXPOSE 2567 80` to `EXPOSE 8080` (only expose nginx port)

**Why:**
- `curl` needed for Docker healthcheck
- Executable permissions ensure start script runs
- Only nginx port needs to be exposed (Colyseus is proxied)

### 3. `docker/start.sh`
**Changes:**
- Added dynamic runtime.json generation from `PUBLIC_WS_URL` environment variable
- Converts HTTP(S) URLs to WS(S) URLs automatically
- Added logging of configured WebSocket URL

**Why:**
- Client needs to know WebSocket URL at runtime (varies per deployment)
- Coolify injects domain via magic variables
- Automatic protocol conversion ensures correct ws:// or wss:// scheme

### 4. `docker/nginx.conf`
**Changes:**
- Added `upstream colyseus` block for backend
- Changed location block from `/api/` to `~ ^/(api/|matchmake/|riot_room)`
- Added proper WebSocket headers (`Upgrade`, `Connection`)
- Added proxy headers for real IP forwarding
- Increased `proxy_read_timeout` to 86400 seconds (24 hours)
- Reordered location blocks (proxy first, then static files)

**Why:**
- Colyseus uses multiple paths for WebSocket connections
- Regex location block catches all Colyseus traffic
- WebSocket connections need proper upgrade headers
- Long timeout prevents WebSocket disconnects
- Order matters for nginx location matching

## New Files

### 1. `DEPLOY.md`
Comprehensive deployment guide covering:
- Step-by-step Coolify deployment instructions
- Architecture diagram
- Troubleshooting guide
- Performance tuning recommendations
- Security notes

### 2. `test-deploy.sh`
Local testing script that:
- Builds and starts services with Docker Compose
- Waits for health checks to pass
- Tests all endpoints (client, runtime config, API)
- Provides clear pass/fail output

### 3. `COOLIFY_CHANGES.md`
This file - documents all changes for reference.

## Configuration Flow

### Production (Coolify)
```
1. Coolify assigns domain (e.g., game.example.com)
2. Coolify injects: SERVICE_FQDN_APP_80=https://game.example.com
3. start.sh reads PUBLIC_WS_URL env variable
4. start.sh converts to: wss://game.example.com
5. start.sh writes runtime.json with wsUrl
6. Client loads runtime.json at startup
7. Client connects to wss://game.example.com
```

### Local Testing
```
1. Set: SERVICE_FQDN_APP_80=http://localhost
2. start.sh converts to: ws://localhost
3. Client connects to ws://localhost:2567 (fallback if runtime.json empty)
```

## Architecture

### Before (Development)
```
Client (5173) ←→ Server (2567)
```

### After (Production)
```
Coolify/Traefik (443/80)
    ↓
Nginx (8080)
    ↓
Colyseus (2567)
```

## Testing Checklist

Before deploying to Coolify:

- [ ] Run `./test-deploy.sh` locally
- [ ] Verify client loads at http://localhost
- [ ] Check runtime.json is generated correctly
- [ ] Confirm WebSocket connection works (check browser console)
- [ ] Test game functionality (movement, etc.)

After deploying to Coolify:

- [ ] Assign domain in Coolify
- [ ] Wait for SSL certificate generation
- [ ] Check service health status in Coolify
- [ ] View logs for "WebSocket URL configured: wss://..."
- [ ] Test client loads at assigned domain
- [ ] Verify WebSocket connection (browser console)
- [ ] Test game functionality

## Rollback Plan

If deployment fails:

1. **Check logs in Coolify dashboard**
2. **Common issues:**
   - Build failure: Check Dockerfile syntax
   - Unhealthy: Check nginx/start.sh logs
   - Connection failed: Verify SERVICE_FQDN_APP_80 is set
3. **Rollback:** Coolify keeps previous deployments, rollback in UI

## Migration Notes

### From Local Development
No code changes needed. The `GameApp.ts` already supports runtime configuration:
```typescript
const runtimeWs = (window as any).__PUBLIC_WS_URL as string | undefined;
const rawUrl = runtimeWs || env.VITE_PUBLIC_WS_URL || fallback;
```

### From Other Hosting
If migrating from another host:
1. Remove any hardcoded WebSocket URLs
2. Rely on runtime.json for WebSocket URL
3. Update DNS to point to Coolify
4. Coolify handles SSL automatically

## Performance Impact

**Build time:** ~2-3 minutes (pnpm install + build client + build server)
**Startup time:** ~5-10 seconds (nginx + node startup)
**Image size:** ~500MB (includes Node.js, nginx, dependencies)

**Optimizations applied:**
- Multi-stage build (reduces final image size)
- Layer caching (node_modules cached separately)
- Slim base image (node:20-slim)
- Production builds only (no dev dependencies)

## Security Considerations

**Improvements:**
- All traffic HTTPS/WSS in production (via Coolify/Traefik)
- No direct access to game server (proxied through nginx)
- Minimal exposed ports (only 8080)
- Healthchecks prevent unhealthy deployments

**Still needed:**
- Authentication on animation upload API
- Rate limiting on game connections
- Input validation on all API endpoints

## Next Steps

1. **Push changes to Git:**
   ```bash
   git add .
   git commit -m "feat: add Coolify deployment support"
   git push
   ```

2. **Deploy to Coolify:**
   - Create new resource in Coolify
   - Select repository
   - Assign domain
   - Click Deploy

3. **Monitor:**
   - Watch build logs
   - Check health status
   - Test game functionality

4. **Iterate:**
   - Add monitoring/metrics
   - Configure backups
   - Set up staging environment
