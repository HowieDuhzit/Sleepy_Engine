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
const gamesDir =
  process.env.GAMES_DIR ??
  process.env.PROJECTS_DIR ??
  path.join(process.cwd(), 'server', 'projects');
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

const gameCreateSchema = z.object({
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
const sceneGroundSchema = z
  .object({
    type: z.enum(['concrete']).optional(),
    width: z.number().optional(),
    depth: z.number().optional(),
    y: z.number().optional(),
    textureRepeat: z.number().optional(),
  })
  .passthrough();
const scenesPayloadSchema = z.object({
  scenes: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(64),
        obstacles: z.array(sceneObstacleSchema).optional(),
        ground: sceneGroundSchema.optional(),
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

const safeAssetName = (name: string) => {
  const base = path.basename(name);
  return base.replace(/[^a-z0-9._-]/gi, '_');
};

// ============================================================================
// GAME MANAGEMENT API
// All assets are managed per-game via /api/games/:gameId/*
// ============================================================================

const ensureGameDir = async (gameId: string) => {
  await fs.mkdir(path.join(gamesDir, gameId), { recursive: true });
  await fs.mkdir(path.join(gamesDir, gameId, 'animations'), { recursive: true });
  await fs.mkdir(path.join(gamesDir, gameId, 'scenes'), { recursive: true });
  await fs.mkdir(path.join(gamesDir, gameId, 'avatars'), { recursive: true });
  await fs.mkdir(path.join(gamesDir, gameId, 'assets'), { recursive: true });
  await fs.mkdir(path.join(gamesDir, gameId, 'logic'), { recursive: true });
};

const safeGameId = (id: string) => {
  return id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
};

const cacheKey = (...parts: string[]) => `sleepy:${parts.join(':')}`;
const readGameMeta = async (gameId: string) => {
  const gameMetaPath = path.join(gamesDir, gameId, 'game.json');
  const legacyMetaPath = path.join(gamesDir, gameId, 'project.json');
  try {
    const raw = await fs.readFile(gameMetaPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    const raw = await fs.readFile(legacyMetaPath, 'utf8');
    return JSON.parse(raw);
  }
};

// List all games
app.get('/api/games', async (_req: Request, res: Response) => {
  try {
    await fs.mkdir(gamesDir, { recursive: true });
    const entries = await fs.readdir(gamesDir, { withFileTypes: true });
    const games = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const gameId = entry.name;

      try {
        const meta = await readGameMeta(gameId);
        games.push({ id: gameId, ...meta });
      } catch {
        // No metadata, create default
        games.push({
          id: gameId,
          name: gameId,
          description: '',
          createdAt: new Date().toISOString(),
        });
      }
    }

    res.json({ games });
  } catch (err) {
    console.error('List games failed', err);
    res.status(500).json({ error: 'failed_to_list', detail: String(err) });
  }
});

// Create new game
app.post('/api/games', requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = gameCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    const { name, description } = parsed.data;

    const gameId = safeGameId(name);
    const gamePath = path.join(gamesDir, gameId);

    // Check if exists
    try {
      await fs.access(gamePath);
      res.status(409).json({ error: 'game_exists' });
      return;
    } catch {
      // Doesn't exist, good
    }

    await ensureGameDir(gameId);

    const meta = {
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(gamePath, 'game.json'),
      JSON.stringify(meta, null, 2)
    );

    res.json({ ok: true, id: gameId, ...meta });
  } catch (err) {
    console.error('Create game failed', err);
    res.status(500).json({ error: 'failed_to_create_game', detail: String(err) });
  }
});

// Get game details
app.get('/api/games/:gameId', async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    if (!gameId) {
      res.status(400).json({ error: 'missing_game_id' });
      return;
    }

    const meta = await readGameMeta(gameId);

    res.json({ id: gameId, ...meta });
  } catch (err) {
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

// List game animations
app.get('/api/games/:gameId/animations', async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    if (!gameId) {
      res.status(400).json({ error: 'missing_game_id' });
      return;
    }

    await ensureGameDir(gameId);
    const listKey = cacheKey('game', gameId, 'animations', 'list');
    const cached = await cacheGet(listKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }

    const animDir = path.join(gamesDir, gameId, 'animations');
    const entries = await fs.readdir(animDir);
    const files = entries.filter((file) => file.toLowerCase().endsWith('.json'));

    const payload = JSON.stringify({ files });
    await cacheSet(listKey, payload);
    res.json({ files });
  } catch (err) {
    console.error('List game animations failed', err);
    res.status(500).json({ error: 'failed_to_list', detail: String(err) });
  }
});

// Get game animation
app.get('/api/games/:gameId/animations/:name', async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    const rawName = req.params.name ?? '';
    if (!gameId || !rawName) {
      res.status(400).json({ error: 'missing_params' });
      return;
    }

    const filename = safeName(rawName);
    const fileKey = cacheKey('game', gameId, 'animations', filename);
    const cached = await cacheGet(fileKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }
    const filePath = path.join(gamesDir, gameId, 'animations', filename);
    const raw = await fs.readFile(filePath, 'utf8');
    await cacheSet(fileKey, raw);
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (err) {
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

// Get game avatar asset
app.get('/api/games/:gameId/avatars/:name', async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    const rawName = req.params.name ?? '';
    if (!gameId || !rawName) {
      res.status(400).json({ error: 'missing_params' });
      return;
    }

    const filename = safeAssetName(rawName);
    const filePath = path.join(gamesDir, gameId, 'avatars', filename);
    const buffer = await fs.readFile(filePath);
    if (filename.toLowerCase().endsWith('.vrm') || filename.toLowerCase().endsWith('.glb')) {
      res.setHeader('Content-Type', 'model/gltf-binary');
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

// Get game player config
app.get('/api/games/:gameId/player', async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    if (!gameId) {
      res.status(400).json({ error: 'missing_game_id' });
      return;
    }

    await ensureGameDir(gameId);
    const fileKey = cacheKey('game', gameId, 'player');
    const cached = await cacheGet(fileKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }
    const filePath = path.join(gamesDir, gameId, 'player.json');
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      await cacheSet(fileKey, raw);
      res.setHeader('Content-Type', 'application/json');
      res.send(raw);
    } catch {
      const fallback = '{}';
      await cacheSet(fileKey, fallback);
      res.setHeader('Content-Type', 'application/json');
      res.send(fallback);
    }
  } catch (err) {
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

// Save game player config
app.post('/api/games/:gameId/player', requireAdmin, async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    if (!gameId) {
      res.status(400).json({ error: 'missing_game_id' });
      return;
    }

    const parsed = playerPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }

    await ensureGameDir(gameId);
    const filePath = path.join(gamesDir, gameId, 'player.json');
    const payload = JSON.stringify(parsed.data, null, 2);
    await fs.writeFile(filePath, payload);
    await cacheSet(cacheKey('game', gameId, 'player'), payload);
    res.json({ ok: true, file: 'player.json' });
  } catch (err) {
    res.status(500).json({ error: 'failed_to_save', detail: String(err) });
  }
});

// Legacy player config endpoint (prototype game)
app.get('/api/player-config', async (_req: Request, res: Response) => {
  res.redirect('/api/games/prototype/player');
});

app.post('/api/player-config', requireAdmin, async (req: Request, res: Response) => {
  res.redirect(307, '/api/games/prototype/player');
});

// Save game animation
app.post('/api/games/:gameId/animations/:name', requireAdmin, async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    const rawName = req.params.name ?? '';
    if (!gameId || !rawName) {
      res.status(400).json({ error: 'missing_params' });
      return;
    }

    const parsed = animationPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }

    await ensureGameDir(gameId);
    const filename = safeName(rawName);
    const filePath = path.join(gamesDir, gameId, 'animations', filename);
    const payload = JSON.stringify(parsed.data, null, 2);
    await fs.writeFile(filePath, payload);
    await cacheSet(cacheKey('game', gameId, 'animations', filename), payload);
    await cacheDel(cacheKey('game', gameId, 'animations', 'list'));

    res.json({ ok: true, file: filename });
  } catch (err) {
    res.status(500).json({ error: 'failed_to_save', detail: String(err) });
  }
});

// Get game scenes
app.get('/api/games/:gameId/scenes', async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    if (!gameId) {
      res.status(400).json({ error: 'missing_game_id' });
      return;
    }

    await ensureGameDir(gameId);
    const fileKey = cacheKey('game', gameId, 'scenes');
    const cached = await cacheGet(fileKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.send(cached);
      return;
    }
    const filePath = path.join(gamesDir, gameId, 'scenes', 'scenes.json');

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
            name: 'main',
            obstacles: [],
          },
        ],
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'failed_to_read', detail: String(err) });
  }
});

// Save game scenes
app.post('/api/games/:gameId/scenes', requireAdmin, async (req: Request, res: Response) => {
  try {
    const gameId = safeGameId(req.params.gameId ?? '');
    if (!gameId) {
      res.status(400).json({ error: 'missing_game_id' });
      return;
    }

    const parsed = scenesPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }

    await ensureGameDir(gameId);
    const filePath = path.join(gamesDir, gameId, 'scenes', 'scenes.json');
    const payload = JSON.stringify(parsed.data, null, 2);
    await fs.writeFile(filePath, payload);
    await cacheSet(cacheKey('game', gameId, 'scenes'), payload);

    res.json({ ok: true, file: 'scenes.json' });
  } catch (err) {
    res.status(500).json({ error: 'failed_to_save', detail: String(err) });
  }
});

// Ensure games directory exists on startup
const ensureGamesDir = async () => {
  await fs.mkdir(gamesDir, { recursive: true });
};

// Backward compatibility: legacy projects routes redirect to games routes.
app.use('/api/projects', (req: Request, res: Response) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const pathname = req.url.split('?')[0] ?? '';
  res.redirect(307, `/api/games${pathname}${query}`);
});

const httpServer = createServer(app);
gameServer.attach({ server: httpServer });

// Ensure games directory exists before starting server
ensureGamesDir().then(() => {
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
