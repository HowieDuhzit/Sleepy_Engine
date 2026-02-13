import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL;

export const redisEnabled = Boolean(redisUrl);

export const redisClient = redisUrl
  ? createClient({ url: redisUrl })
  : null;

if (redisClient) {
  redisClient.on('error', (err) => {
    console.error('Redis error:', err);
  });
}

export const redisHealth = async () => {
  if (!redisClient) return { enabled: false };
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    const pong = await redisClient.ping();
    return { enabled: true, ok: pong === 'PONG' };
  } catch (err) {
    return { enabled: true, ok: false, error: String(err) };
  }
};

const ensureRedis = async () => {
  if (!redisClient) return null;
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  return redisClient;
};

export const cacheGet = async (key: string) => {
  const client = await ensureRedis();
  if (!client) return null;
  return client.get(key);
};

export const cacheSet = async (key: string, value: string, ttlSeconds = 30) => {
  const client = await ensureRedis();
  if (!client) return;
  await client.set(key, value, { EX: ttlSeconds });
};

export const cacheDel = async (key: string) => {
  const client = await ensureRedis();
  if (!client) return;
  await client.del(key);
};

export const closeRedis = async () => {
  if (!redisClient) return;
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
};
