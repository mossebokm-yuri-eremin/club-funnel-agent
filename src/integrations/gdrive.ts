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
import { geminiFetch } from './gemini-fetch.js';

export interface GDriveUploadResult {
  fileId: string;
  webViewLink: string;
}

export interface GDriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
}

export interface GDriveUploader {
  uploadPdf(args: { filename: string; bytes: Buffer; folderId?: string }): Promise<GDriveUploadResult>;
}

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// Объединённый scope: drive.file — для upload своих файлов, drive.readonly —
// для чтения папок и файлов, которые расшарены на сервис-аккаунт.
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';

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

async function loadServiceAccountOrThrow(): Promise<ServiceAccountJson> {
  const sa = await loadServiceAccount();
  if (!sa) {
    throw new Error(
      'gdrive: GDRIVE_SERVICE_ACCOUNT_JSON_PATH not configured or invalid (нужен service account JSON)',
    );
  }
  return sa;
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

// Кэш access token (1 час TTL у Google, обновляем за 5 минут до истечения).
let cachedToken: { value: string; expiresAt: number } | null = null;

async function exchangeJwtForAccessToken(sa: ServiceAccountJson): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60_000) {
    return cachedToken.value;
  }
  const jwt = signJwt(sa, SCOPE);
  const res = await geminiFetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
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
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('gdrive: token exchange returned no access_token');
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
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
  const res = await geminiFetch(
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

/**
 * Перечисляет файлы в папке GDrive (folderId). Возвращает только нетриашенные.
 * Папка должна быть расшарена на client_email сервис-аккаунта (Viewer достаточно).
 *
 * Бросает ошибку если service account не настроен или Google API ответил 4xx/5xx.
 */
export async function listFolderFiles(folderId: string): Promise<GDriveFileMeta[]> {
  const sa = await loadServiceAccountOrThrow();
  const token = await exchangeJwtForAccessToken(sa);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,md5Checksum,size)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000`;
  const res = await geminiFetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gdrive: list folder ${folderId} failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { files?: GDriveFileMeta[] };
  return json.files ?? [];
}

/**
 * Скачивает файл по fileId. Только для бинарных/текстовых файлов (не Google Docs/Slides —
 * для тех нужен export endpoint).
 */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const sa = await loadServiceAccountOrThrow();
  const token = await exchangeJwtForAccessToken(sa);
  const res = await geminiFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gdrive: download ${fileId} failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log.debug({ fileId, bytes: buf.length }, 'gdrive: file downloaded');
  return buf;
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9 extensions: GDrive helpers for carousel style-transfer
//   - getFolderIdByName(parentId, name) → ищет подпапку по имени
//   - listFolderRecursive(folderId, opts) → рекурсивный обход
//   - downloadAndCache(fileId, opts) → загрузка с локальным TTL-кэшем
//   - extFromMime(mime) → расширение по MIME
// Кэш: GDRIVE_CACHE_DIR (default /var/club-funnel/template-cache), TTL = GDRIVE_CACHE_TTL_HOURS (default 24h).
// ─────────────────────────────────────────────────────────────────────────────

import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const CACHE_DIR = process.env.GDRIVE_CACHE_DIR ?? '/var/club-funnel/template-cache';
const CACHE_TTL_MS = (Number(process.env.GDRIVE_CACHE_TTL_HOURS) || 24) * 3600_000;

export function extFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('svg')) return 'svg';
  return 'bin';
}

/** Ищет подпапку с заданным именем внутри parentId. Возвращает id или null. */
export async function getFolderIdByName(
  parentId: string,
  name: string,
): Promise<string | null> {
  const sa = await loadServiceAccountOrThrow();
  const token = await exchangeJwtForAccessToken(sa);
  const q = encodeURIComponent(
    `'${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}'`,
  );
  const fields = encodeURIComponent('files(id,name)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=10`;
  const res = await geminiFetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const t = await res.text();
    log.warn(
      { parentId, name, status: res.status, body: t.slice(0, 200) },
      'gdrive: getFolderIdByName failed',
    );
    return null;
  }
  const json = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return json.files?.[0]?.id ?? null;
}

/** Рекурсивный обход папки. Опц. фильтр по MIME-префиксу ('image/'). */
export async function listFolderRecursive(
  folderId: string,
  opts: { mimePrefix?: string; maxDepth?: number } = {},
): Promise<GDriveFileMeta[]> {
  const maxDepth = opts.maxDepth ?? 5;
  const out: GDriveFileMeta[] = [];
  async function walk(id: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const items = await listFolderFiles(id);
    for (const f of items) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        await walk(f.id, depth + 1);
      } else {
        if (!opts.mimePrefix || f.mimeType.startsWith(opts.mimePrefix)) {
          out.push(f);
        }
      }
    }
  }
  await walk(folderId, 0);
  return out;
}

/** Скачивает файл с локальным TTL-кэшем. Возвращает буфер + путь к кэшу. */
export async function downloadAndCache(
  fileId: string,
  opts: { mimeHint?: string; ext?: string } = {},
): Promise<{ path: string; buf: Buffer; cached: boolean }> {
  const ext = opts.ext ?? (opts.mimeHint ? extFromMime(opts.mimeHint) : 'bin');
  const cachePath = path.join(CACHE_DIR, `${fileId}.${ext}`);
  // Hit
  if (existsSync(cachePath)) {
    try {
      const st = await stat(cachePath);
      if (Date.now() - st.mtimeMs < CACHE_TTL_MS) {
        const buf = await readFile(cachePath);
        return { path: cachePath, buf, cached: true };
      }
    } catch {
      // fallthrough — refresh
    }
  }
  // Miss → fetch
  const buf = await downloadFile(fileId);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, buf);
  return { path: cachePath, buf, cached: false };
}
