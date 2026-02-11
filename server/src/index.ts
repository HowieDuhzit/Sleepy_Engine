import colyseusPkg from 'colyseus';
import express, { type Request, type Response } from 'express';
import { createServer } from 'http';
import path from 'path';
import { promises as fs } from 'fs';
import { RiotRoom } from './rooms/RiotRoom.js';

const port = Number(process.env.GAME_PORT ?? process.env.COLYSEUS_PORT ?? process.env.PORT ?? 2567);
const animationsDir =
  process.env.ANIMATIONS_DIR ?? path.join(process.cwd(), 'client', 'public', 'animations');
const configDir = process.env.CONFIG_DIR ?? path.join(process.cwd(), 'client', 'public', 'config');
const { Server } = colyseusPkg as typeof import('colyseus');
const gameServer = new Server();

gameServer.define('riot_room', RiotRoom).enableRealtimeListing();

const app = express();
app.use(express.json({ limit: '25mb' }));

const ensureDir = async () => {
  await fs.mkdir(animationsDir, { recursive: true });
};
const ensureConfigDir = async () => {
  await fs.mkdir(configDir, { recursive: true });
};

const safeName = (name: string) => {
  const base = path.basename(name);
  const cleaned = base.replace(/[^a-z0-9._-]/gi, '_');
  return cleaned.toLowerCase().endsWith('.json') ? cleaned : `${cleaned}.json`;
};

const updateManifest = async (filename: string) => {
  const manifestPath = path.join(animationsDir, 'manifest.json');
  let files: string[] = [];
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const data = JSON.parse(raw) as { files?: string[] };
    if (Array.isArray(data.files)) files = data.files;
  } catch {
    // ignore
  }
  if (!files.includes(filename)) {
    files.push(filename);
    files.sort();
    await fs.writeFile(manifestPath, JSON.stringify({ files }, null, 2));
  }
};

app.get('/api/animations', async (_req: Request, res: Response) => {
  try {
    await ensureDir();
    const entries = await fs.readdir(animationsDir);
    const files = entries.filter((file) => file.toLowerCase().endsWith('.json'));
    res.json({ files });
  } catch (err) {
    console.error('List animations failed', err);
    res.status(500).json({ error: 'failed_to_list', detail: String(err) });
  }
});

app.get('/api/animations/:name', async (req: Request, res: Response) => {
  try {
    await ensureDir();
    const rawName = req.params.name ?? '';
    if (!rawName) {
      res.status(400).json({ error: 'missing_name' });
      return;
    }
    const filename = safeName(rawName);
    const filePath = path.join(animationsDir, filename);
    const raw = await fs.readFile(filePath, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (err) {
    console.error('Read animation failed', err);
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

app.post('/api/animations/:name', async (req: Request, res: Response) => {
  try {
    await ensureDir();
    const rawName = req.params.name ?? '';
    if (!rawName) {
      res.status(400).json({ error: 'missing_name' });
      return;
    }
    const filename = safeName(rawName);
    const filePath = path.join(animationsDir, filename);
    await fs.writeFile(filePath, JSON.stringify(req.body, null, 2));
    await updateManifest(filename);
    res.json({ ok: true, file: filename });
  } catch (err) {
    console.error('Save animation failed', err);
    res.status(500).json({ error: 'failed_to_save', detail: String(err), dir: animationsDir });
  }
});

app.get('/api/player-config', async (_req: Request, res: Response) => {
  try {
    await ensureConfigDir();
    const filePath = path.join(configDir, 'player.json');
    const raw = await fs.readFile(filePath, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (err) {
    console.error('Read player config failed', err);
    res.status(404).json({ error: 'not_found', detail: String(err) });
  }
});

app.post('/api/player-config', async (req: Request, res: Response) => {
  try {
    await ensureConfigDir();
    const filePath = path.join(configDir, 'player.json');
    await fs.writeFile(filePath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true, file: 'player.json' });
  } catch (err) {
    console.error('Save player config failed', err);
    res.status(500).json({ error: 'failed_to_save', detail: String(err), dir: configDir });
  }
});

const httpServer = createServer(app);
gameServer.attach({ server: httpServer });
httpServer.listen(port);
console.log(`Game server listening on ws://localhost:${port}`);

process.on('SIGTERM', () => {
  gameServer.gracefullyShutdown();
});

process.on('SIGINT', () => {
  gameServer.gracefullyShutdown();
});
