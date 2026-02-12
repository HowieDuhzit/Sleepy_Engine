export type ProjectMeta = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type SceneRecord = {
  name: string;
  obstacles?: unknown[];
};

const readJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return (await response.json()) as T;
};

export const listProjects = async () => {
  const res = await fetch('/api/projects', { cache: 'no-store' });
  const data = await readJson<{ projects: ProjectMeta[] }>(res);
  return data.projects;
};

export const createProject = async (payload: { name: string; description?: string }) => {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ id: string; name: string }>(res);
};

export const getProjectScenes = async (projectId: string) => {
  const res = await fetch(`/api/projects/${projectId}/scenes`, { cache: 'no-store' });
  return readJson<{ scenes?: SceneRecord[] }>(res);
};

export const saveProjectScenes = async (projectId: string, payload: { scenes: SceneRecord[] }) => {
  const res = await fetch(`/api/projects/${projectId}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; file: string }>(res);
};

export const getProjectPlayer = async <T>(projectId: string) => {
  const res = await fetch(`/api/projects/${projectId}/player`, { cache: 'no-store' });
  return readJson<T>(res);
};

export const saveProjectPlayer = async (projectId: string, payload: unknown) => {
  const res = await fetch(`/api/projects/${projectId}/player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; file: string }>(res);
};

export const listProjectAnimations = async (projectId: string) => {
  const res = await fetch(`/api/projects/${projectId}/animations`, { cache: 'no-store' });
  return readJson<{ files?: string[] }>(res);
};

export const getProjectAnimation = async (projectId: string, name: string) => {
  const res = await fetch(`/api/projects/${projectId}/animations/${encodeURIComponent(name)}`, { cache: 'no-store' });
  return readJson<unknown>(res);
};

export const saveProjectAnimation = async (projectId: string, name: string, payload: unknown) => {
  const res = await fetch(`/api/projects/${projectId}/animations/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson<{ ok: boolean; file: string }>(res);
};
