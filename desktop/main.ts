import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { promises as fs } from 'fs';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const animationsDir = path.join(app.getAppPath(), 'client', 'public', 'animations');

const ensureDir = async () => {
  await fs.mkdir(animationsDir, { recursive: true });
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

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop', 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5175');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(app.getAppPath(), 'client', 'dist', 'index.html'));
  }
};

ipcMain.handle('animations:info', async () => ({ animationsDir }));

ipcMain.handle('animations:list', async () => {
  await ensureDir();
  const entries = await fs.readdir(animationsDir);
  return entries.filter((file) => file.toLowerCase().endsWith('.json'));
});

ipcMain.handle('animations:read', async (_event, name: string) => {
  await ensureDir();
  if (!name) return null;
  const filename = safeName(name);
  const filePath = path.join(animationsDir, filename);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle('animations:write', async (_event, name: string, clip: unknown) => {
  await ensureDir();
  if (!name || !clip) return { ok: false, error: 'missing_payload' };
  const filename = safeName(name);
  const filePath = path.join(animationsDir, filename);
  try {
    await fs.writeFile(filePath, JSON.stringify(clip, null, 2));
    await updateManifest(filename);
    return { ok: true, file: filename };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
