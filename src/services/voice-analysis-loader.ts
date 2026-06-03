// voice-analysis-loader — парсит knowledge/voice-analysis-ye-v3.md → typed JSON.
//
// Источник: knowledge/voice-analysis-ye-v3.md (сгенерирован Opus 4.8 один раз
// на корпусе 18 реальных постов + knowledge/rz-funnel-content/*).
//
// Кэшируем в памяти процесса — файл загружается один раз при старте.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface CharacteristicPhrase {
  phrase: string;
  frequency: number;
  contexts: string[];
}

export interface Rhythm {
  avg_sentence_length_words: number;
  short_sentences_pct: number;
  long_sentences_pct: number;
  parcellation_usage: 'high' | 'medium' | 'low';
  one_sentence_paragraph_usage: 'high' | 'medium' | 'low';
}

export interface Glossary {
  uses_often: string[];
  never_uses: string[];
  professional_terms: Record<string, string>;
}

export interface Structure {
  name: string;
  steps: string[];
  example_post_id: string;
}

export interface RealStory {
  name: string;
  city: string | null;
  check_before: number | null;
  check_after: number | null;
  period: string | null;
  angle: string;
  source_post_id: string;
}

export interface HookFirstLine {
  type: string;
  examples: string[];
}

export interface EndingCta {
  type: string;
  examples: string[];
}

export interface Tone {
  directness: 'high' | 'medium' | 'low';
  self_irony: 'high' | 'medium' | 'low';
  authority: 'high' | 'medium' | 'low';
  vulnerability: 'high' | 'medium' | 'low';
}

export interface VoiceAnalysis {
  characteristic_phrases: CharacteristicPhrase[];
  rhythm: Rhythm;
  glossary: Glossary;
  structures: Structure[];
  real_stories: RealStory[];
  forbidden_constructions: string[];
  hooks_first_line: HookFirstLine[];
  endings_cta: EndingCta[];
  tone: Tone;
}

const PATHS = [
  '/opt/club-funnel/knowledge/voice-analysis-ye-v3.md',
  './knowledge/voice-analysis-ye-v3.md',
];

let cached: VoiceAnalysis | null = null;

export async function getVoiceAnalysis(voice: 'YE' | 'RZ' = 'YE'): Promise<VoiceAnalysis> {
  // RZ пока использует тот же анализ — для голоса Виктории отдельный корпус не собран.
  // Когда появятся реальные посты Виктории — сгенерируем voice-analysis-rz-v3.md.
  void voice;
  if (cached) return cached;
  let raw: string | null = null;
  for (const p of PATHS) {
    if (existsSync(p)) {
      raw = await readFile(p, 'utf8');
      break;
    }
  }
  if (!raw) {
    throw new Error('voice-analysis: voice-analysis-ye-v3.md not found. Run scripts/voice-analyze-v3.ts');
  }
  const m = raw.match(/```json\s*([\s\S]+?)\s*```/);
  if (!m || !m[1]) throw new Error('voice-analysis: no JSON block in voice-analysis-ye-v3.md');
  cached = JSON.parse(m[1]) as VoiceAnalysis;
  return cached;
}

export function resetVoiceAnalysisCache(): void {
  cached = null;
}
