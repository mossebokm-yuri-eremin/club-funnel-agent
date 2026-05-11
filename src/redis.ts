import { Redis, type RedisOptions } from 'ioredis';
import { config } from './config.js';
import { log } from './observability/logger.js';

const baseOptions: RedisOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  db: config.REDIS_DB,
  lazyConnect: false,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

if (config.REDIS_PASSWORD) {
  baseOptions.password = config.REDIS_PASSWORD;
}

export const redis = new Redis(baseOptions);

redis.on('error', (err) => {
  log.error({ err }, 'redis: connection error');
});

redis.on('connect', () => {
  log.info({ host: config.REDIS_HOST, port: config.REDIS_PORT }, 'redis: connected');
});

export function createRedisClient(): Redis {
  return new Redis(baseOptions);
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
