import pino, { type Logger, type LoggerOptions } from 'pino';
import { config } from '../config.js';

const redactPaths: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-getcourse-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  '*.api_key',
  '*.apiKey',
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
  '*.refreshToken',
  '*.secret',
  '*.password',
  '*.token',
  '*.hmac',
  '*.signature',
  '*.email',
  '*.phone',
  // ПД абонентов 152-ФЗ
  'subscriber.email',
  'subscriber.phone',
  'payload.email',
  'payload.phone',
];

const baseOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  base: {
    app: config.APP_NAME,
    env: config.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
};

if (config.LOG_REDACT_PD) {
  baseOptions.redact = { paths: redactPaths, censor: '[REDACTED]', remove: false };
}

const prettyTransport = config.LOG_PRETTY
  ? {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    }
  : {};

export const log: Logger = pino({ ...baseOptions, ...prettyTransport });

export function child(bindings: Record<string, unknown>): Logger {
  return log.child(bindings);
}
