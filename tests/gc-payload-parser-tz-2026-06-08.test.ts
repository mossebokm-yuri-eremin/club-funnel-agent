// Тесты для gc-payload-parser — ТЗ 2026-06-08 (наследие ye-ambassador-bot).
//
// Проверяем:
//   - smartAmountToKopecks обрабатывает "5 000 руб.", nbsp, "1 234,56₽", "RUB 750"
//   - parseGcDate понимает ISO/SQL/русский с/без секунд/двойными пробелами

import { describe, it, expect } from 'vitest';
import { smartAmountToKopecks, parseGcDate } from '../src/services/gc-payload-parser.js';

describe('smartAmountToKopecks (ТЗ 2026-06-08)', () => {
  it('"5 000 руб." → 500000 копеек', () => {
    expect(smartAmountToKopecks('5 000 руб.')).toBe(500000);
  });
  it('"5000,50 руб" → 500050 копеек', () => {
    expect(smartAmountToKopecks('5000,50 руб')).toBe(500050);
  });
  it('"5000" строка → 500000 копеек', () => {
    expect(smartAmountToKopecks('5000')).toBe(500000);
  });
  it('"" → 0', () => {
    expect(smartAmountToKopecks('')).toBe(0);
  });
  it('number 5000 → 500000 копеек', () => {
    expect(smartAmountToKopecks(5000)).toBe(500000);
  });
  it('"1 234,56₽" → 123456 копеек', () => {
    expect(smartAmountToKopecks('1 234,56₽')).toBe(123456);
  });
  it('"RUB 750" → 75000 копеек', () => {
    expect(smartAmountToKopecks('RUB 750')).toBe(75000);
  });
  it('null/undefined/object → 0', () => {
    expect(smartAmountToKopecks(null)).toBe(0);
    expect(smartAmountToKopecks(undefined)).toBe(0);
    expect(smartAmountToKopecks({})).toBe(0);
  });
  it('nbsp в числе: "5 000 руб." → 500000', () => {
    expect(smartAmountToKopecks('5 000 руб.')).toBe(500000);
  });
  it('целое >=10000 без дроби трактуется как уже копейки (legacy)', () => {
    expect(smartAmountToKopecks(500000)).toBe(500000); // 500000 копеек уже
    expect(smartAmountToKopecks('500000')).toBe(500000);
  });
});

describe('parseGcDate (ТЗ 2026-06-08)', () => {
  it('пустая → null', () => {
    expect(parseGcDate('')).toBeNull();
  });
  it('null/undefined → null', () => {
    expect(parseGcDate(null)).toBeNull();
    expect(parseGcDate(undefined)).toBeNull();
  });
  it('"0000-00-00 00:00:00" → null (не 0000-год)', () => {
    expect(parseGcDate('0000-00-00 00:00:00')).toBeNull();
  });
  it('SQL МСК → UTC-3', () => {
    expect(parseGcDate('2026-06-08 15:30:00')).toBe('2026-06-08T12:30:00.000Z');
  });
  it('ISO с TZ Z', () => {
    expect(parseGcDate('2026-06-08T15:30:00Z')).toBe('2026-06-08T15:30:00.000Z');
  });
  it('русский МСК "08.06.2026 14:46" → UTC 11:46', () => {
    expect(parseGcDate('08.06.2026 14:46')).toBe('2026-06-08T11:46:00.000Z');
  });
  it('"08.06.2026  14:46" (двойной пробел) → UTC 11:46', () => {
    expect(parseGcDate('08.06.2026  14:46')).toBe('2026-06-08T11:46:00.000Z');
  });
  it('"08.06.2026" → начало суток МСК (UTC предыдущего дня 21:00)', () => {
    expect(parseGcDate('08.06.2026')).toBe('2026-06-07T21:00:00.000Z');
  });
  it('"08.06.2026 14:46:23" с секундами', () => {
    expect(parseGcDate('08.06.2026 14:46:23')).toBe('2026-06-08T11:46:23.000Z');
  });
  it('URL-кодированный плюс в TZ: "2026-05-23T11:58:13 00:00" → +00:00', () => {
    expect(parseGcDate('2026-05-23T11:58:13 00:00')).toBe('2026-05-23T11:58:13.000Z');
  });
  it('некорректная дата → null', () => {
    expect(parseGcDate('not-a-date')).toBeNull();
  });
});
