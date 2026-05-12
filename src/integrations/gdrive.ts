// Минимальный клиент Google Drive — только то, что нужно Phase 4:
// загрузить PDF в папку GDRIVE_LONGREADS_FOLDER_ID и вернуть {fileId, webViewLink}.
//
// Зачем без googleapis SDK: чтобы не тянуть тяжёлый transitive граф ради одного
// upload'а. Подписываем JWT для service account и шлём resumable upload.
//
// Поведение:
//   - Если GDRIVE_SERVICE_ACCOUNT_JSON_PATH не задан → возвращаем заглушку
//     (file_id = `local-<sha1>`, web_view_link = file://...) и WARN в логи.
//     Это нужно тестам и локальной разработке; в prod-конфиге оператор должен
//     задать service account.
//   - 4xx/5xx → исключение + лог.

import { createHash, createSign, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export interface GDriveUploadResult {
  fileId: string;
  webViewLink: string;
}

export interface GDriveUploader {
  uploadPdf(args: { filename: string; bytes: Buffer; folderId?: string }): Promise<GDriveUploadResult>;
}

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

async function loadServiceAccount(): Promise<ServiceAccountJson | null> {
  const p = config.GDRIVE_SERVICE_ACCOUNT_JSON_PATH;
  if (!p) return null;
  try {
    const raw = await readFile(p, 'utf8');
    const json = JSON.parse(raw) as Partial<ServiceAccountJson>;
    if (!json.client_email || !json.private_key) {
      log.warn({ path: p }, 'gdrive: service account JSON malformed');
      return null;
    }
    return json as ServiceAccountJson;
  } catch (err) {
    log.warn({ err: (err as Error).message, path: p }, 'gdrive: cannot read service account');
    return null;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwt(sa: ServiceAccountJson, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function exchangeJwtForAccessToken(sa: ServiceAccountJson): Promise<string> {
  const jwt = signJwt(sa, 'https://www.googleapis.com/auth/drive.file');
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gdrive: token exchange failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('gdrive: token exchange returned no access_token');
  return body.access_token;
}

async function multipartUpload(
  accessToken: string,
  filename: string,
  bytes: Buffer,
  folderId: string,
): Promise<GDriveUploadResult> {
  const boundary = `gdrive-${randomUUID()}`;
  const metadata = { name: filename, parents: [folderId], mimeType: 'application/pdf' };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gdrive: upload failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id: string; webViewLink?: string };
  return {
    fileId: json.id,
    webViewLink: json.webViewLink ?? `https://drive.google.com/file/d/${json.id}/view`,
  };
}

async function localFallback(filename: string, bytes: Buffer): Promise<GDriveUploadResult> {
  const dir = path.resolve(config.DATA_DIR, 'longreads');
  await mkdir(dir, { recursive: true });
  const sha = createHash('sha1').update(bytes).digest('hex').slice(0, 12);
  const safeName = `${sha}-${filename.replace(/[^a-z0-9._-]+/gi, '_')}`;
  const absPath = path.join(dir, safeName);
  await writeFile(absPath, bytes);
  log.warn(
    { absPath, sha },
    'gdrive: service account not configured — saved PDF locally instead',
  );
  return { fileId: `local-${sha}`, webViewLink: `file://${absPath}` };
}

export function createGDriveUploader(): GDriveUploader {
  return {
    async uploadPdf({ filename, bytes, folderId }) {
      const sa = await loadServiceAccount();
      const targetFolder = folderId ?? config.GDRIVE_LONGREADS_FOLDER_ID;
      if (!sa || !targetFolder) {
        return localFallback(filename, bytes);
      }
      const accessToken = await exchangeJwtForAccessToken(sa);
      return multipartUpload(accessToken, filename, bytes, targetFolder);
    },
  };
}
