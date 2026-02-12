import colyseusPkg from 'colyseus';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'http';
import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { RiotRoom } from './rooms/RiotRoom.js';
import { closeDb, dbEnabled, dbHealth } from './db.js';
import { cacheDel, cacheGet, cacheSet, closeRedis, redisEnabled, redisHealth } from './redis.js';
import { RedisPresence } from '@colyseus/redis-presence';
import { RedisDriver } from '@colyseus/redis-driver';

const port = Number(process.env.GAME_PORT ?? process.env.COLYSEUS_PORT ?? process.env.PORT ?? 2567);
const projectsDir = process.env.PROJECTS_DIR ?? path.join(process.cwd(), 'projects');
const redisUrl = process.env.REDIS_URL;
const { Server } = colyseusPkg as typeof import('colyseus');
const gameServer = redisUrl
  ? new Server({
      presence: new RedisPresence(redisUrl),
      driver: new RedisDriver(redisUrl),
    })
  : new Server();

gameServer.define('riot_room', RiotRoom).enableRealtimeListing();

const app = express();
app.use(express.json({ limit: '25mb' }));
const adminToken = process.env.ADMIN_TOKEN?.trim();

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = randomUUID();
  const start = Date.now();
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    const elapsedMs = Date.now() - start;
    console.log(
      JSON.stringify({
        level: 'info',
        type: 'http_request',
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        elapsedMs,
      }),
    );
  });
  next();
});

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!adminToken) {
    next();
    return;
  }
  if (req.header('x-admin-token') === adminToken) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
};

const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(1024).optional().default(''),
});

const animationPayloadSchema = z.record(z.unknown());
const playerPayloadSchema = z.record(z.unknown());
const sceneObstacleSchema = z
  .object({
    id: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    depth: z.number().optional(),
    position: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
    size: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  })
  .passthrough();
const scenesPayloadSchema = z.object({
  scenes: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(64),
        obstacles: z.array(sceneObstacleSchema).optional(),
      }),
    )
    .max(500),
});

app.get('/api/db/health', async (_req: Request, res: Response) => {
  const status = await dbHealth();
  res.json(status);
});

app.get('/api/redis/health', async (_req: Request, res: Response) => {
  const status = await redisHealth();
  res.json(status);
});

// Helper function for sanitizing file names
const safeName = (name: string) => {
  const base = path.basename(name);
  const cleaned = base.replace(/[^a-z0-9._-]/gi, '_');
  return cleaned.toLowerCase().endsWith('.json') ? cleaned : `${cleaned}.json`;
};

// ============================================================================
// PROJECT MANAGEMENT API
// All assets are managed per-project via /api/projects/:projectId/*
// ============================================================================

const ensureProjectDir = async (projectId: string) => {
  await fs.mkdir(path.join(projectsDir, projectId), { recursive: true });
  await fs.mkdir(path.join(projectsDir, projectId, 'animations'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, projectId, 'scenes'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, projectId, 'assets'), { recursive: true });
};

const safeProjectId = (id: string) => {
  return id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
};

const cacheKey = (...parts: string[]) => `sleepy:${parts.join(':')}`;

// List all projects
app.get('/api/projects', async (_req: Request, res: Response) => {
  try {
    await fs.mkdir(projectsDir, { recursive: true });
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectId = entry.name;
      const metaPath = path.join(projectsDir, projectId, 'project.json');

      try {
        const metaRaw = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw);
        projects.push({ id: projectId, ...meta });
      } catch {
        // No metadata, create default
        projects.push({
          id: projectId,
          name: projectId,
          description: '',
          createdAt: new Date().toISOString(),
        });
      }
    }

    res.json({ projects });
  } catch (err) {
    console.error('List projects failed', err);
    res.status(500).json({ error: 'failed_to_list', detail: String(err) });
  }
});

// Create new project
app.post('/api/projects', requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = projectCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    const { name, description } = parsed.data;

    const projectId = safeProjectId(name);
    const projectPath = path.join(projectsDir, projectId);

    // Check if exists
    try {
      await fs.access(projectPath);
      res.status(409).json({ error: 'project_exists' });
      return;
    } catch {
      // Doesn't exist, good
    }

    await ensureProjectDir(projectId);

    const meta = {
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(projectPath, 'project.json'),
      JSON.stringify(meta, null, 2)
    );

    res.json({ ok: true, id: projectId, ...meta });
  } catch (err) {
    console.error('Create project failed', err);
    res.status(500).json({ error: 'failed_to_create', detail: String(err) });
  }
});

// Get project details
app.get('/api/projects/:projectId', async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    if (!projectId) {
      res.status(400).json({ error: 'missing_project_id' });
      return;
    }

    const metaPath = path.join(projectsDir, projectId, 'project.json');
    const metaRaw = await fs.readFile(metaPath, 'utf8');
    const meta = JSON.parse(metaRaw);

    res.json({ id: projectId, ...meta });
  } catch (err) {
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

// List project animations
app.get('/api/projects/:projectId/animations', async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    if (!projectId) {
      res.status(400).json({ error: 'missing_project_id' });
      return;
    }

    await ensureProjectDir(projectId);
    const listKey = cacheKey('project', projectId, 'animations', 'list');
    const cached = await cacheGet(listKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }

    const animDir = path.join(projectsDir, projectId, 'animations');
    const entries = await fs.readdir(animDir);
    const files = entries.filter((file) => file.toLowerCase().endsWith('.json'));

    const payload = JSON.stringify({ files });
    await cacheSet(listKey, payload);
    res.json({ files });
  } catch (err) {
    console.error('List project animations failed', err);
    res.status(500).json({ error: 'failed_to_list', detail: String(err) });
  }
});

// Get project animation
app.get('/api/projects/:projectId/animations/:name', async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    const rawName = req.params.name ?? '';
    if (!projectId || !rawName) {
      res.status(400).json({ error: 'missing_params' });
      return;
    }

    const filename = safeName(rawName);
    const fileKey = cacheKey('project', projectId, 'animations', filename);
    const cached = await cacheGet(fileKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }
    const filePath = path.join(projectsDir, projectId, 'animations', filename);
    const raw = await fs.readFile(filePath, 'utf8');
    await cacheSet(fileKey, raw);
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (err) {
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

// Get project player config
app.get('/api/projects/:projectId/player', async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    if (!projectId) {
      res.status(400).json({ error: 'missing_project_id' });
      return;
    }

    await ensureProjectDir(projectId);
    const fileKey = cacheKey('project', projectId, 'player');
    const cached = await cacheGet(fileKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }
    const filePath = path.join(projectsDir, projectId, 'player.json');
    const raw = await fs.readFile(filePath, 'utf8');
    await cacheSet(fileKey, raw);
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (err) {
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

// Save project player config
app.post('/api/projects/:projectId/player', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    if (!projectId) {
      res.status(400).json({ error: 'missing_project_id' });
      return;
    }

    const parsed = playerPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }

    await ensureProjectDir(projectId);
    const filePath = path.join(projectsDir, projectId, 'player.json');
    const payload = JSON.stringify(parsed.data, null, 2);
    await fs.writeFile(filePath, payload);
    await cacheSet(cacheKey('project', projectId, 'player'), payload);
    res.json({ ok: true, file: 'player.json' });
  } catch (err) {
    res.status(500).json({ error: 'failed_to_save', detail: String(err) });
  }
});

// Legacy player config endpoint (prototype project)
app.get('/api/player-config', async (_req: Request, res: Response) => {
  res.redirect('/api/projects/prototype/player');
});

app.post('/api/player-config', requireAdmin, async (req: Request, res: Response) => {
  res.redirect(307, '/api/projects/prototype/player');
});

// Save project animation
app.post('/api/projects/:projectId/animations/:name', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    const rawName = req.params.name ?? '';
    if (!projectId || !rawName) {
      res.status(400).json({ error: 'missing_params' });
      return;
    }

    const parsed = animationPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }

    await ensureProjectDir(projectId);
    const filename = safeName(rawName);
    const filePath = path.join(projectsDir, projectId, 'animations', filename);
    const payload = JSON.stringify(parsed.data, null, 2);
    await fs.writeFile(filePath, payload);
    await cacheSet(cacheKey('project', projectId, 'animations', filename), payload);
    await cacheDel(cacheKey('project', projectId, 'animations', 'list'));

    res.json({ ok: true, file: filename });
  } catch (err) {
    res.status(500).json({ error: 'failed_to_save', detail: String(err) });
  }
});

// Get project scenes
app.get('/api/projects/:projectId/scenes', async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    if (!projectId) {
      res.status(400).json({ error: 'missing_project_id' });
      return;
    }

    await ensureProjectDir(projectId);
    const fileKey = cacheKey('project', projectId, 'scenes');
    const cached = await cacheGet(fileKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }
    const filePath = path.join(projectsDir, projectId, 'scenes', 'scenes.json');

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      await cacheSet(fileKey, raw);
      res.setHeader('Content-Type', 'application/json');
      res.send(raw);
    } catch {
      // No scenes file, return default
      res.json({
        scenes: [
          {
            name: 'prototype',
            obstacles: [
              { x: 0, y: 0, z: 0, width: 2, height: 2, depth: 2 },
              { x: 5, y: 0, z: 0, width: 1, height: 3, depth: 1 },
              { x: -5, y: 0, z: 0, width: 1, height: 3, depth: 1 },
            ],
          },
        ],
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'failed_to_read', detail: String(err) });
  }
});

// Save project scenes
app.post('/api/projects/:projectId/scenes', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projectId = safeProjectId(req.params.projectId ?? '');
    if (!projectId) {
      res.status(400).json({ error: 'missing_project_id' });
      return;
    }

    const parsed = scenesPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }

    await ensureProjectDir(projectId);
    const filePath = path.join(projectsDir, projectId, 'scenes', 'scenes.json');
    const payload = JSON.stringify(parsed.data, null, 2);
    await fs.writeFile(filePath, payload);
    await cacheSet(cacheKey('project', projectId, 'scenes'), payload);

    res.json({ ok: true, file: 'scenes.json' });
  } catch (err) {
    res.status(500).json({ error: 'failed_to_save', detail: String(err) });
  }
});

// Ensure projects directory exists on startup
const ensureProjectsDir = async () => {
  await fs.mkdir(projectsDir, { recursive: true });
};

const httpServer = createServer(app);
gameServer.attach({ server: httpServer });

// Ensure projects directory exists before starting server
ensureProjectsDir().then(() => {
  httpServer.listen(port);
  console.log(`Game server listening on ws://localhost:${port}`);
  if (dbEnabled) {
    console.log('Database enabled via DATABASE_URL');
  }
  if (redisEnabled) {
    console.log('Redis enabled via REDIS_URL');
  }
});

process.on('SIGTERM', async () => {
  await closeDb();
  await closeRedis();
  gameServer.gracefullyShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeDb();
  await closeRedis();
  gameServer.gracefullyShutdown();
  process.exit(0);
});
