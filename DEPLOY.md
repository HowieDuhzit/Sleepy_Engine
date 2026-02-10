# Coolify Deployment Guide

This guide explains how to deploy TrashyGame to Coolify.

## Prerequisites

- Coolify instance running (v4.0.0-beta.411+)
- Git repository pushed to GitHub/GitLab/Gitea
- Docker Compose support enabled on your Coolify server

## Deployment Steps

### 1. Create New Resource in Coolify

1. Go to your Coolify dashboard
2. Click "New Resource" → "Docker Compose"
3. Select your Git repository or paste the repository URL
4. Set the branch (usually `main`)

### 2. Configure Service

The `docker-compose.yml` is already configured for Coolify with:

- ✅ Automatic domain assignment via `SERVICE_FQDN_APP_80` magic variable
- ✅ Health checks for service monitoring
- ✅ Proper port mapping (internal 8080 → external 80)
- ✅ Named volumes for persistent data
- ✅ WebSocket support for Colyseus game server

### 3. Assign Domain

1. In Coolify, go to your service settings
2. Assign a domain (e.g., `game.yourdomain.com`)
3. Coolify will automatically:
   - Configure SSL/TLS via Let's Encrypt
   - Set up Traefik routing
   - Inject the domain into `SERVICE_FQDN_APP_80`

### 4. Deploy

Click "Deploy" - Coolify will:
1. Build the Docker image with the `allinone` target
2. Start the container with nginx + Colyseus game server
3. Configure the WebSocket URL automatically from the assigned domain
4. Monitor health via the configured healthcheck

## How It Works

### Architecture

```
┌─────────────────────────────────────────┐
│          Coolify + Traefik              │
│  (SSL termination, domain routing)      │
└─────────────────┬───────────────────────┘
                  │
                  │ HTTPS/WSS
                  ▼
        ┌─────────────────────┐
        │   Nginx (port 8080) │
        │   - Serves client   │
        │   - Proxies WS/API  │
        └──────────┬──────────┘
                   │
                   │ HTTP/WS (local)
                   ▼
        ┌──────────────────────┐
        │ Colyseus (port 2567) │
        │  - Game server       │
        │  - REST API          │
        │  - WebSocket rooms   │
        └──────────────────────┘
```

### Dynamic Configuration

The `start.sh` script automatically:
1. Reads `PUBLIC_WS_URL` environment variable (set by Coolify's magic variable)
2. Converts HTTP(S) URLs to WS(S) URLs
3. Generates `/app/config/runtime.json` with the WebSocket URL
4. Client loads this config at startup to connect to the game server

### Persistent Storage

Two named volumes preserve data across deployments:
- `animations-data` - Animation files (uploaded via API)
- `config-data` - Configuration files and player data

## Environment Variables

The following variables are automatically set:

| Variable | Source | Purpose |
|----------|--------|---------|
| `PUBLIC_WS_URL` | `${SERVICE_FQDN_APP_80}` | WebSocket URL for client |
| `ANIMATIONS_DIR` | Hardcoded | Path to animations directory |
| `CONFIG_DIR` | Hardcoded | Path to config directory |

## Troubleshooting

### WebSocket connection fails

**Check logs:**
```bash
# In Coolify, view service logs
```

**Verify runtime config:**
The container should log: `WebSocket URL configured: wss://yourdomain.com`

### Health check failing

The health check pings `http://localhost:8080/` every 30 seconds.

**Common causes:**
- Nginx not starting (check logs)
- Port 8080 not listening
- Start script failed

### No domain assigned

If you deploy without assigning a domain:
- The service will use a fallback WebSocket URL: `ws://localhost:2567`
- This will only work for local testing, not production

**Solution:** Assign a domain in Coolify service settings

### Animations not loading

Animations are bundled into the Docker image from `client/public/animations/`.

**To add new animations:**
1. Use the API: `POST /api/animations/:name` (while container is running)
2. Or rebuild the image with new animation files in the source

## Advanced Configuration

### Custom WebSocket URL

If you need to override the WebSocket URL:

1. In Coolify, add environment variable:
   ```
   PUBLIC_WS_URL=wss://custom-domain.com
   ```

2. Coolify will inject this instead of the auto-generated domain

### Separate Game Server

For high-traffic deployments, you can split the services:

1. Deploy game server separately (use `target: server` in Dockerfile)
2. Deploy client separately (use `target: client` in Dockerfile)
3. Configure `PUBLIC_WS_URL` to point to the game server domain

## Monitoring

### Health Check

Coolify monitors the service via:
- Endpoint: `http://localhost:8080/`
- Interval: 30 seconds
- Timeout: 10 seconds
- Retries: 3
- Start period: 40 seconds (allows time for nginx + server to start)

### Logs

View logs in Coolify dashboard:
- **Application logs** - Node.js game server output
- **Nginx logs** - HTTP/WebSocket proxy logs
- **Build logs** - Docker build output

## Performance Tuning

### Server Resources

Recommended minimum resources:
- **CPU:** 1 core (2+ for production)
- **RAM:** 512 MB (1GB+ for production)
- **Disk:** 2 GB (includes Node modules + built assets)

### Scaling

The current setup uses in-memory state (Colyseus default).

**For multi-instance deployments:**
1. Configure Colyseus presence (Redis)
2. Enable session affinity in Coolify/Traefik
3. Use a shared storage solution for animations/config

## Security Notes

- ✅ All traffic uses HTTPS/WSS in production (handled by Coolify)
- ✅ Nginx proxies prevent direct server access
- ✅ Volumes are isolated per deployment
- ⚠️ No authentication on game server (implement if needed)
- ⚠️ Animation upload API is unauthenticated (add auth if exposed)

## Support

For issues specific to:
- **Coolify deployment:** Check [Coolify docs](https://coolify.io/docs)
- **Game code:** See `CLAUDE.md` in repository
- **Docker build:** Review `Dockerfile` and build logs
