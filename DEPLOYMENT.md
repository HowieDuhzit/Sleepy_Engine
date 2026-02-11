# Deployment Guide

## Overview

This project uses GitHub Actions to build Docker images and Coolify for deployment.

## Architecture

- **GitHub Actions**: Builds and pushes Docker images to Docker Hub on every push to `main`
- **Docker Hub**: Hosts the pre-built images at `howieduhzit/sleepyengine:main`
- **Coolify**: Pulls the pre-built image and deploys it as a service

## Setup Instructions

### 1. Configure GitHub Secrets

Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):

- `DOCKERHUB_USERNAME`: Your Docker Hub username (howieduhzit)
- `DOCKERHUB_TOKEN`: Docker Hub access token (create at https://hub.docker.com/settings/security)

### 2. Push to Main Branch

The GitHub Action will automatically:
1. Build the Docker image from the `allinone` target
2. Tag it as `howieduhzit/sleepyengine:main` and `howieduhzit/sleepyengine:latest`
3. Push to Docker Hub
4. Cache layers for faster subsequent builds

### 3. Deploy to Coolify

#### Option A: Using the Coolify UI

1. Create a new service in Coolify
2. Choose "Docker Compose"
3. Upload or paste the `docker-compose.yml` file
4. Assign a domain to the `game` service
5. Deploy

#### Option B: Using the Coolify Git Integration

1. Connect your GitHub repository to Coolify
2. Point to the `docker-compose.yml` file
3. Assign a domain to the `game` service
4. Coolify will auto-deploy on new commits

### 4. Configure Coolify Service

The compose file uses Coolify's magic variables:

- `SERVICE_FQDN_GAME_80`: Auto-populated with your assigned domain
- This will be available as `APP_URL` environment variable inside the container

### 5. Persistent Storage

The deployment uses named volumes for:

- `game-animations`: Animation files
- `game-config`: Configuration files
- `game-data`: Runtime data

These persist across container restarts and redeployments.

## Local Testing

To test the Docker build locally before pushing:

```bash
# Build and run locally
docker compose -f docker-compose.local.yml up --build

# Or build the image manually
docker build -t sleepyengine:local --target allinone .
docker run -p 5173:80 sleepyengine:local
```

Access at http://localhost:5173

## Architecture Details

### All-in-One Container

The `allinone` Docker target includes:
- **Nginx**: Serves static client files and proxies WebSocket connections
- **Colyseus Server**: Game server running on port 2567 (internal)
- **Client Assets**: Built React/Three.js application

### Port Configuration

- **Port 80**: HTTP entry point (Nginx)
  - Serves static files from `/usr/share/nginx/html`
  - Proxies `/animations` to `/app/animations`
  - Proxies `/config` to `/app/config`
  - Proxies WebSocket connections to Colyseus server (port 2567)

### Nginx Proxy Configuration

The nginx configuration:
1. Tries to serve files directly from the filesystem
2. Falls back to proxying requests to the Colyseus server
3. Handles WebSocket upgrade for multiplayer connections

## Troubleshooting

### Image Build Fails

Check the GitHub Actions logs at: `https://github.com/HowieDuhzit/TrashyGame/actions`

### Service Won't Start in Coolify

1. Check Coolify logs for the service
2. Verify the image exists: `docker pull howieduhzit/sleepyengine:main`
3. Check health check status in Coolify

### WebSocket Connection Issues

1. Ensure Coolify proxy is configured correctly
2. Check that your domain has SSL enabled (Coolify auto-handles this)
3. Verify nginx logs inside the container

## Manual Image Management

### Pull the latest image
```bash
docker pull howieduhzit/sleepyengine:main
```

### View all tags
```bash
docker images howieduhzit/sleepyengine
```

### Manual build and push
```bash
docker build -t howieduhzit/sleepyengine:main --target allinone .
docker push howieduhzit/sleepyengine:main
```

## Rolling Back

To roll back to a previous version:

1. In Coolify, change the image tag in the compose file
2. Find the previous commit SHA from GitHub Actions
3. Update compose to use: `howieduhzit/sleepyengine:main-<commit-sha>`
4. Redeploy

## Monitoring

- **GitHub Actions**: Monitor builds at https://github.com/HowieDuhzit/TrashyGame/actions
- **Docker Hub**: View image history at https://hub.docker.com/r/howieduhzit/sleepyengine
- **Coolify**: Monitor service health, logs, and metrics in the Coolify dashboard
