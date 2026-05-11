// Минимальный клиент Deepgram REST API для prerecorded transcription.
// Используется в src/services/stt.ts. HTTP — native fetch (Node 22+).
//
// API: POST https://api.deepgram.com/v1/listen
//   Body: либо JSON { url } либо binary audio (Content-Type: audio/*)
//   Headers: Authorization: Token <DEEPGRAM_API_KEY>
//   Query: model, language, smart_format, punctuate, diarize, ...
// Response (v1): { results: { channels: [{ alternatives: [{ transcript, confidence, ... }] }] } }

import { z } from 'zod';

const TranscriptionAlternativeSchema = z.object({
  transcript: z.string(),
  confidence: z.number().optional(),
});

const TranscriptionChannelSchema = z.object({
  alternatives: z.array(TranscriptionAlternativeSchema).min(1),
  detected_language: z.string().optional(),
  language: z.string().optional(),
});

const TranscriptionResultsSchema = z.object({
  channels: z.array(TranscriptionChannelSchema).min(1),
  metadata: z
    .object({
      duration: z.number().optional(),
    })
    .partial()
    .optional(),
});

export const DeepgramResponseSchema = z.object({
  results: TranscriptionResultsSchema,
  metadata: z
    .object({
      duration: z.number().optional(),
      request_id: z.string().optional(),
    })
    .partial()
    .optional(),
});
export type DeepgramResponse = z.infer<typeof DeepgramResponseSchema>;

export interface DeepgramClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;     // 'nova-3' default
  language?: string;  // 'ru' default
  /** Допускает инъекцию fetch (для тестов). */
  fetchImpl?: typeof fetch;
}

export interface TranscribeUrlArgs {
  url: string;
  mimeType?: string;
}

export interface TranscribeBufferArgs {
  buffer: Buffer;
  mimeType: string; // 'audio/ogg', 'audio/mp3', 'audio/wav', ...
}

export interface TranscribeResult {
  text: string;
  confidence: number; // 0..1
  language: string;
  durationSec?: number;
  requestId?: string;
}

export class DeepgramError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'DeepgramError';
  }
}

export class DeepgramClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly language: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DeepgramClientOptions) {
    if (!opts.apiKey) throw new Error('DeepgramClient: apiKey required');
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.deepgram.com';
    this.model = opts.model ?? 'nova-3';
    this.language = opts.language ?? 'ru';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'false',
    });
    return `${this.baseUrl}/v1/listen?${params.toString()}`;
  }

  private parseResponse(json: unknown): TranscribeResult {
    const parsed = DeepgramResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new DeepgramError(`malformed response: ${parsed.error.message}`);
    }
    const channel = parsed.data.results.channels[0]!;
    const alt = channel.alternatives[0]!;
    const result: TranscribeResult = {
      text: alt.transcript ?? '',
      confidence: alt.confidence ?? 0,
      language: channel.detected_language ?? channel.language ?? this.language,
    };
    const duration = parsed.data.metadata?.duration ?? parsed.data.results.metadata?.duration;
    if (typeof duration === 'number') result.durationSec = duration;
    const requestId = parsed.data.metadata?.request_id;
    if (typeof requestId === 'string') result.requestId = requestId;
    return result;
  }

  async transcribeUrl(args: TranscribeUrlArgs): Promise<TranscribeResult> {
    const res = await this.fetchImpl(this.buildUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: args.url }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new DeepgramError(`deepgram url transcribe failed: ${res.status}`, res.status, body);
    }
    const json = (await res.json()) as unknown;
    return this.parseResponse(json);
  }

  async transcribeBuffer(args: TranscribeBufferArgs): Promise<TranscribeResult> {
    const res = await this.fetchImpl(this.buildUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': args.mimeType,
      },
      // Buffer наследует Uint8Array → валидное тело fetch. TS не выводит это
      // через lib ES2023, поэтому подсовываем через Uint8Array.
      body: new Uint8Array(args.buffer.buffer, args.buffer.byteOffset, args.buffer.byteLength),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new DeepgramError(`deepgram buffer transcribe failed: ${res.status}`, res.status, body);
    }
    const json = (await res.json()) as unknown;
    return this.parseResponse(json);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
