import { contextBridge, ipcRenderer } from 'electron';

type ClipData = {
  duration: number;
  frames: Array<{
    time: number;
    bones: Record<string, { x: number; y: number; z: number; w: number }>;
    rootPos?: { x: number; y: number; z: number };
  }>;
};

type AnimationsApi = {
  list: () => Promise<string[]>;
  load: (name: string) => Promise<ClipData | null>;
  save: (name: string, clip: ClipData) => Promise<{ ok: boolean; file?: string; error?: string }>;
  info: () => Promise<{ animationsDir: string }>;
};

const api: { animations: AnimationsApi } = {
  animations: {
    list: () => ipcRenderer.invoke('animations:list'),
    load: (name) => ipcRenderer.invoke('animations:read', name),
    save: (name, clip) => ipcRenderer.invoke('animations:write', name, clip),
    info: () => ipcRenderer.invoke('animations:info'),
  },
};

contextBridge.exposeInMainWorld('sleepyDesktop', api);
