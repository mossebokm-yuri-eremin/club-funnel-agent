// Обязательный тест из CLAUDE.md «Тесты, которые обязательно зелёные».
// Таблица: similarity > 0.85 → A, < 0.65 → C, среднее → решение Opus.

import { describe, it, expect, vi } from 'vitest';
import { chooseStrategy } from '../src/services/strategy-chooser.js';
import type {
  BonusCandidate,
  StrategyChooserInput,
} from '../src/services/strategy-chooser.js';

function makeInput(over: Partial<StrategyChooserInput> = {}): StrategyChooserInput {
  return {
    idea: {
      id: 'idea-1',
      summary: 'Как поднять цену чека после первого договора',
      painTag: 'check_growth',
      source: 'voice',
    },
    topCandidates: [],
    ideasSinceLastB: 0,
    ...over,
  };
}

function bonus(over: Partial<BonusCandidate> = {}): BonusCandidate {
  return {
    bonusId: '11111111-1111-1111-1111-111111111111',
    title: 'Чек 5000 за 8 недель',
    similarity: 0.5,
    crHistory: 0.07,
    daysSinceLastUse: 12,
    usesLast30d: 1,
    ...over,
  };
}

describe('strategy-chooser', () => {
  it('similarity > 0.85 → A детерминированно, без вызова LLM', async () => {
    const llmSpy = vi.fn();
    const decision = await chooseStrategy(
      makeInput({ topCandidates: [bonus({ similarity: 0.9 })] }),
      { callLlm: llmSpy as never },
    );
    expect(decision.strategy).toBe('A');
    expect(decision.deterministic).toBe(true);
    expect(decision.bonusId).toBe('11111111-1111-1111-1111-111111111111');
    expect(decision.recommendedPromptVersion).toMatch(/twin_ye@v1/);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('similarity < 0.65 → C детерминированно, без вызова LLM', async () => {
    const llmSpy = vi.fn();
    const decision = await chooseStrategy(
      makeInput({ topCandidates: [bonus({ similarity: 0.5 })] }),
      { callLlm: llmSpy as never },
    );
    expect(decision.strategy).toBe('C');
    expect(decision.deterministic).toBe(true);
    expect(decision.bonusId).toBeNull();
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('пустой bonus_library → C (cold start)', async () => {
    const llmSpy = vi.fn();
    const decision = await chooseStrategy(makeInput({ topCandidates: [] }), {
      callLlm: llmSpy as never,
    });
    expect(decision.strategy).toBe('C');
    expect(decision.deterministic).toBe(true);
    expect(decision.bonusId).toBeNull();
    expect(decision.reasoning).toMatch(/cold start|пустая|нет/i);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('серая зона 0.65–0.85 → решает Opus (LLM)', async () => {
    const llmSpy = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        strategy: 'A',
        reason: 'CR падает, но лонгрид свежий — продолжаем качать.',
        bonus_id: '11111111-1111-1111-1111-111111111111',
      }),
      thinkingText: '',
      usage: {},
      stopReason: 'end_turn',
      model: 'claude-opus-4-7',
      raw: {},
      costUsd: 0.01,
    });
    const decision = await chooseStrategy(
      makeInput({ topCandidates: [bonus({ similarity: 0.75 })] }),
      { callLlm: llmSpy as never },
    );
    expect(llmSpy).toHaveBeenCalledTimes(1);
    expect(decision.strategy).toBe('A');
    expect(decision.deterministic).toBe(false);
    expect(decision.bonusId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('серая зона: LLM может выбрать C — bonus_id зануляется', async () => {
    const llmSpy = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        strategy: 'C',
        reason: 'Тема смещена в новый угол, лучше отдельный лонгрид.',
        bonus_id: null,
      }),
      thinkingText: '',
      usage: {},
      stopReason: 'end_turn',
      model: 'claude-opus-4-7',
      raw: {},
      costUsd: 0.01,
    });
    const decision = await chooseStrategy(
      makeInput({ topCandidates: [bonus({ similarity: 0.7 })] }),
      { callLlm: llmSpy as never },
    );
    expect(decision.strategy).toBe('C');
    expect(decision.bonusId).toBeNull();
  });

  it('A/B-тест: ideasSinceLastB ≥ 10 и ratio<1.5 → B (без LLM)', async () => {
    const llmSpy = vi.fn();
    const decision = await chooseStrategy(
      makeInput({
        topCandidates: [bonus({ similarity: 0.75 })],
        ideasSinceLastB: 10,
        abMetrics: { crA: 0.08, crB: 0.07 },
      }),
      { callLlm: llmSpy as never },
    );
    expect(decision.strategy).toBe('B');
    expect(decision.deterministic).toBe(true);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('A/B-тест НЕ срабатывает, если ratio ≥ 1.5 (A сильно бьёт B)', async () => {
    const llmSpy = vi.fn().mockResolvedValue({
      text: JSON.stringify({ strategy: 'A', reason: 'ok', bonus_id: null }),
      thinkingText: '',
      usage: {},
      stopReason: 'end_turn',
      model: 'm',
      raw: {},
      costUsd: 0,
    });
    const decision = await chooseStrategy(
      makeInput({
        topCandidates: [bonus({ similarity: 0.75 })],
        ideasSinceLastB: 12,
        abMetrics: { crA: 0.12, crB: 0.04 }, // ratio = 3
      }),
      { callLlm: llmSpy as never },
    );
    // А/В-тест не сработал → серая зона → LLM
    expect(llmSpy).toHaveBeenCalled();
    expect(decision.strategy).toBe('A');
  });

  it('forcedBonusId → A немедленно, без LLM, без проверки similarity', async () => {
    const llmSpy = vi.fn();
    const decision = await chooseStrategy(
      makeInput({
        topCandidates: [bonus({ similarity: 0.1 })],
        forcedBonusId: '22222222-2222-2222-2222-222222222222',
      }),
      { callLlm: llmSpy as never },
    );
    expect(decision.strategy).toBe('A');
    expect(decision.bonusId).toBe('22222222-2222-2222-2222-222222222222');
    expect(decision.deterministic).toBe(true);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('LLM вернула невалидный JSON → fallback A на top1', async () => {
    const llmSpy = vi.fn().mockResolvedValue({
      text: 'не json вовсе',
      thinkingText: '',
      usage: {},
      stopReason: 'end_turn',
      model: 'm',
      raw: {},
      costUsd: 0,
    });
    const decision = await chooseStrategy(
      makeInput({ topCandidates: [bonus({ similarity: 0.72 })] }),
      { callLlm: llmSpy as never },
    );
    expect(decision.strategy).toBe('A');
    expect(decision.deterministic).toBe(false);
  });

  it('граничные пороги: 0.85 не считается > 0.85 → серая зона', async () => {
    const llmSpy = vi.fn().mockResolvedValue({
      text: JSON.stringify({ strategy: 'A', reason: 'ok', bonus_id: null }),
      thinkingText: '',
      usage: {},
      stopReason: 'end_turn',
      model: 'm',
      raw: {},
      costUsd: 0,
    });
    const decision = await chooseStrategy(
      makeInput({ topCandidates: [bonus({ similarity: 0.85 })] }),
      { callLlm: llmSpy as never },
    );
    // 0.85 не > 0.85, и не < 0.65 → серая зона → должен быть вызван LLM
    expect(llmSpy).toHaveBeenCalled();
    expect(decision.strategy).toBe('A');
  });
});
