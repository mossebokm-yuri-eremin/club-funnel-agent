// Gemini 2.5 Pro Video — анализ видео/каруселей референсов (SPEC AC-40).
//
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// Для видео > 20MB используется File API (upload → file_uri); для видео ≤ 20MB — inline
// (base64). MVP: inline только, для больших видео caller должен предварительно урезать.

import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export interface AnalyzeVideoInput {
  /** Локальный путь до mp4. */
  localPath: string;
  /** mime — по умолчанию video/mp4. */
  mimeType?: string;
  /** Тип ассета — влияет на промпт. */
  assetKind: 'reel' | 'carousel' | 'post';
}

export interface VideoAnalysis {
  transcript: string;
  visual: {
    shots: string[];
    emotions: string[];
    onscreen_text: string[];
    pacing: string;
  };
}

export interface GeminiVideoDeps {
  fetchFn?: typeof fetch;
  readFile?: typeof fs.readFile;
  baseUrl?: string;
}

const VisualSchema = z.object({
  shots: z.array(z.string()).default([]),
  emotions: z.array(z.string()).default([]),
  onscreen_text: z.array(z.string()).default([]),
  pacing: z.string().default(''),
});
const AnalysisSchema = z.object({
  transcript: z.string().default(''),
  visual: VisualSchema,
});

const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(
            z.object({
              text: z.string().optional(),
              inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
            }),
          ),
        }),
        finishReason: z.string().optional(),
      }),
    )
    .min(1),
});

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_INLINE_BYTES = 19 * 1024 * 1024; // 19 MB, чуть ниже лимита 20 MB

function buildPrompt(kind: AnalyzeVideoInput['assetKind']): string {
  return [
    `Проанализируй ${kind === 'reel' ? 'Instagram-Reels' : kind === 'carousel' ? 'карусель' : 'видео-пост'}.`,
    'Верни ТОЛЬКО валидный JSON по схеме:',
    '{',
    '  "transcript": "<полная русская транскрипция речи; если речи нет — пустая строка>",',
    '  "visual": {',
    '    "shots": ["крупный план", "средний план", ...],',
    '    "emotions": ["радость", "сосредоточенность", ...],',
    '    "onscreen_text": ["текст1", ...],',
    '    "pacing": "<динамичный|размеренный|медленный>"',
    '  }',
    '}',
    'Без markdown-обёртки, без комментариев. Не выдумывай — если чего-то нет, оставляй пустые поля.',
  ].join('\n');
}

function extractJson(text: string): string {
  // Иногда модель оборачивает JSON в ```json ... ``` несмотря на инструкцию.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fence?.[1] ?? text).trim();
}

export async function analyzeVideo(
  input: AnalyzeVideoInput,
  deps: GeminiVideoDeps = {},
): Promise<VideoAnalysis> {
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey) throw new Error('gemini-video: GEMINI_API_KEY is not set');
  const model = config.GEMINI_VIDEO_MODEL;
  const { geminiFetch } = await import('./gemini-fetch.js');
  const fetchFn = deps.fetchFn ?? (geminiFetch as unknown as typeof fetch);
  const readFile = deps.readFile ?? fs.readFile;
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

  const data = await readFile(input.localPath);
  if (data.length > MAX_INLINE_BYTES) {
    throw new Error(
      `gemini-video: file ${input.localPath} is ${data.length}B > ${MAX_INLINE_BYTES}B; use File API`,
    );
  }
  const mimeType = input.mimeType ?? 'video/mp4';
  const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        parts: [
          { text: buildPrompt(input.assetKind) },
          { inlineData: { mimeType, data: data.toString('base64') } },
        ],
      },
    ],
    generationConfig: { responseMimeType: 'application/json' },
  };

  log.info(
    { model, kind: input.assetKind, bytes: data.length },
    'gemini-video: requesting analysis',
  );

  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`gemini-video: HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json: unknown = await res.json();
  const parsed = GeminiResponseSchema.parse(json);
  const text = parsed.candidates[0]?.content.parts.find((p) => p.text)?.text ?? '';
  if (!text) throw new Error('gemini-video: empty text in response');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJson(text));
  } catch (err) {
    throw new Error(`gemini-video: JSON parse failed: ${(err as Error).message}`);
  }
  const analysis = AnalysisSchema.parse(parsedJson);
  log.info(
    {
      kind: input.assetKind,
      transcriptLen: analysis.transcript.length,
      shotsN: analysis.visual.shots.length,
      onscreenN: analysis.visual.onscreen_text.length,
    },
    'gemini-video: analysis ready',
  );
  return analysis;
}
