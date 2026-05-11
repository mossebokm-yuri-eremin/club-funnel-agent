import { describe, it, expect } from 'vitest';
import {
  validateVoice,
  YE_MARKERS,
  RZ_MARKERS,
  DEFAULT_MIN_DENSITY,
} from '../src/services/voice-validator.js';

// Натуральный YE-текст, насыщен ДНК-маркерами и без маркетинговых штампов.
const goodYeText = `
Слушай, погнали по делу. Угу, я говорю это уже всем — но до тебя пока не дошло.
Вот смотри: 200 откликов на Авито, чек 30К, конкурируешь с теми, кто работает за еду.
То есть это не профессия, это братская могила. Короче говоря, выход один —
собирать аудиторию у себя. Я в 2014 ушёл и за 18 дней закрыл проект с чеком 350К.
Не магия. Система. Внутри клуба «Реализация» разбираю её каждую неделю на эфирах.
Погнали в клуб, давай по делу.
`;

const goodRzText = `
Полгода назад я не понимала, как писать в Instagram. Честно говоря, делала «красиво»,
получала 12 лайков и тишину. В клубе разобрали мой аккаунт, я применила пару правил —
получилось привести первого клиента с чеком 280К. Если коротко: у меня сработало, и
я думаю, у тебя получится тоже. Приходи в клуб, мы тебя встретим.
`;

describe('voice-validator: YE — золотой кейс', () => {
  it('пропускает живой YE-текст с маркерами и без запретных слов', () => {
    const r = validateVoice({ text: goodYeText, voice: 'YE' });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.density_per_100w).toBeGreaterThanOrEqual(DEFAULT_MIN_DENSITY);
    expect(r.score).toBe(r.density_per_100w);
    expect(r.voice_code).toBe('YE');
  });

  it('считает все вхождения required-маркеров', () => {
    const r = validateVoice({ text: goodYeText, voice: 'YE' });
    const погнали = r.required_markers_found.find((m) => m.marker === 'погнали');
    expect(погнали?.count).toBeGreaterThanOrEqual(2);
  });
});

describe('voice-validator: запрещённые маркеры из CLAUDE.md / SPEC', () => {
  const forbidden = [
    'УТП',
    'возражения',
    'синергия',
    'целевая аудитория',
    'хочу поделиться',
  ];

  for (const word of forbidden) {
    it(`ловит запрещённое слово «${word}»`, () => {
      const text = `${goodYeText}\nКстати, тут есть ${word}, обрати внимание.`;
      const r = validateVoice({ text, voice: 'YE' });
      expect(r.ok).toBe(false);
      const markers = r.violations.map((v) => v.marker);
      expect(markers).toContain(word);
      expect(r.reason).toMatch(/forbidden/);
    });
  }

  it('case-insensitive: «утп», «УТП», «Утп» — одна находка', () => {
    const r = validateVoice({
      text: 'утп — это маркетинговая дичь. Угу. Вот. То есть погнали.',
      voice: 'YE',
    });
    const v = r.violations.find((x) => x.marker === 'УТП');
    expect(v).toBeDefined();
    expect(v?.positions.length).toBe(1);
  });

  it('returns position offsets для подсветки в UI', () => {
    const r = validateVoice({
      text: 'Слово хочу поделиться спрятано в середине, погнали.',
      voice: 'YE',
    });
    const v = r.violations.find((x) => x.marker === 'хочу поделиться');
    expect(v?.positions[0]).toBeGreaterThan(0);
  });

  it('нормализация ё → е (для маркера «следует учитывать»)', () => {
    const r = validateVoice({
      text: 'Слёдует учитывать. Погнали, угу, вот.',
      voice: 'YE',
    });
    const markers = r.violations.map((v) => v.marker);
    expect(markers).toContain('следует учитывать');
  });
});

describe('voice-validator: плотность required-маркеров', () => {
  it('низкая плотность YE-маркеров → ok=false с reason про density', () => {
    const drySolution = `
      В этой статье мы рассмотрим вопрос привлечения клиентов для специалиста
      по интерьерному дизайну. Анализ показывает, что эффективная коммуникация
      требует системного подхода и регулярной публикации профессиональных
      материалов в социальных сетях. Тщательная подготовка контент-плана
      позволяет добиться стабильного потока обращений в течение нескольких
      месяцев работы. Платформы предоставляют разнообразные форматы для подачи
      информации потенциальным клиентам.
    `;
    const r = validateVoice({ text: drySolution, voice: 'YE' });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([]); // запретных нет
    expect(r.density_per_100w).toBeLessThan(DEFAULT_MIN_DENSITY);
    expect(r.reason).toMatch(/density/);
  });

  it('пустой текст → ok=false', () => {
    const r = validateVoice({ text: '   ', voice: 'YE' });
    expect(r.ok).toBe(false);
    expect(r.word_count).toBe(0);
  });

  it('кастомный minDensity повышает планку', () => {
    const r = validateVoice({ text: goodYeText, voice: 'YE', minDensity: 99 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/density/);
  });
});

describe('voice-validator: RZ-голос', () => {
  it('пропускает живой RZ-текст', () => {
    const r = validateVoice({ text: goodRzText, voice: 'RZ' });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('RZ запрещает использовать язык Юрия — «погнали» и «братская могила»', () => {
    // Если Виктория начинает говорить как Юрий — отбраковка (см. SPEC EC-18).
    const r = validateVoice({
      text: 'Я в клубе разобрали, применила, получилось. Погнали внутрь, братская могила Авито.',
      voice: 'RZ',
    });
    expect(r.ok).toBe(false);
    const markers = r.violations.map((v) => v.marker);
    expect(markers).toEqual(expect.arrayContaining(['погнали', 'братская могила']));
  });

  it('missingMarkers содержит только отсутствующие required-маркеры', () => {
    // Намеренно НЕ упоминаем «у меня» и «честно говоря», но используем
    // «я применила», «в клубе разобрали», «получилось» — чтобы плотность была ≥ 0.3.
    const text =
      'Я применила правило с эфира — в клубе разобрали, получилось привести клиента.';
    const r = validateVoice({ text, voice: 'RZ' });
    expect(r.missingMarkers).toContain('у меня');
    expect(r.missingMarkers).toContain('честно говоря');
    expect(r.missingMarkers).not.toContain('применила');
    expect(r.missingMarkers).not.toContain('разобрали');
  });
});

describe('voice-validator: общие свойства API', () => {
  it('каждое required/forbidden слово из дефолтов — непустая строка', () => {
    for (const m of [...YE_MARKERS.required, ...YE_MARKERS.forbidden]) {
      expect(typeof m).toBe('string');
      expect(m.length).toBeGreaterThan(0);
    }
    for (const m of [...RZ_MARKERS.required, ...RZ_MARKERS.forbidden]) {
      expect(typeof m).toBe('string');
      expect(m.length).toBeGreaterThan(0);
    }
  });

  it('кастомные markers переопределяют дефолты', () => {
    const r = validateVoice({
      text: 'абракадабра абракадабра абракадабра',
      voice: 'YE',
      markers: { required: ['абракадабра'], forbidden: [] },
    });
    expect(r.ok).toBe(true);
    expect(r.required_markers_found[0]?.count).toBe(3);
  });
});
