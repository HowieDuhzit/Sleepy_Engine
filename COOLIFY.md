# Coolify Deployment

Simple deployment guide for TrashyGame on Coolify.

## Quick Setup

1. **In Coolify Dashboard:**
   - New Resource → Docker Compose
   - Select your repository
   - Branch: `main`
   - **Compose file:** `docker-compose.coolify.yml`

2. **Assign Domain:**
   - Go to service settings
   - Assign domain (e.g., `game.yourdomain.com`)
   - Coolify will handle SSL automatically

3. **Deploy:**
   - Click "Deploy"
   - Wait for build to complete
   - Service will be available at your domain

## How It Works

```
Client Browser
    ↓ HTTPS/WSS
Coolify (Traefik)
    ↓
Nginx:80
    ↓ WebSocket/HTTP
Game Server:2567
```

**The client automatically:**
- Connects to WebSocket at the same domain it's served from
- Uses `wss://` for HTTPS domains
- Uses `ws://` for HTTP domains

**No configuration needed!**

## Local Testing

```bash
docker compose up --build
```

Open: http://localhost:5173

## Troubleshooting

**WebSocket connection fails:**
- Check Coolify logs: should see game server started on port 2567
- Verify domain is assigned and SSL is active
- Check browser console for connection errors

**Build fails:**
- Ensure pnpm workspace structure is correct
- Check Dockerfile builds locally first

**Game server not starting:**
- Check logs for port conflicts
- Verify animations/config directories are created

## Environment Variables

No special environment variables needed. Everything is auto-configured.

## Persistent Data

Three volumes for data persistence:
- `game-animations` - Animation files
- `game-config` - Configuration files
- `game-data` - Game data

## That's it!

The setup is intentionally simple. Coolify handles:
- SSL/TLS certificates
- Domain routing
- Health checks
- Automatic restarts
