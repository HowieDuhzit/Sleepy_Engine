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

export const closeRedis = async () => {
  if (!redisClient) return;
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
};
