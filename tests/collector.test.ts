import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectionError, parseSourceUpdatedAt, validateFutureMonth, validateRoute } from '../src/collector.js';

describe('displayed source update time', () => {
  it('reads the renewed "좌석 현황은 한국 시간" wording', () => {
    expect(parseSourceUpdatedAt(
      '보너스 좌석 조회 좌석 현황은 한국 시간 2026년 11월 26일 01:30 기준 정보로 실시간 현황이 아닙니다.',
    )).toBe('2026-11-26T01:30:00+09:00');
  });

  it('still reads the legacy "좌석 상황은 대한민국 시간(...)" wording', () => {
    expect(parseSourceUpdatedAt('좌석 상황은 대한민국 시간(2026년 9월 7일 08:05) 기준입니다.'))
      .toBe('2026-09-07T08:05:00+09:00');
  });

  it('returns null instead of guessing when the sentence is absent', () => {
    expect(parseSourceUpdatedAt('보너스 좌석 상황 2027년 1월')).toBeNull();
  });
});

describe('bounded public collection input', () => {
  it('accepts a reversed airport pair without hardcoding ICN as the departure', () => {
    expect(() => validateRoute('SIN', 'ICN')).not.toThrow();
  });

  it.each([['ICN', 'ICN'], ['SEL', 'SIN.*'], ['icn', 'SIN'], ['', 'JFK']])(
    'rejects unsafe or identical route %s → %s before any browser work', (origin, destination) => {
      expect(() => validateRoute(origin, destination)).toThrow(CollectionError);
    },
  );

  it('rejects partial current and too-distant months', () => {
    const now = new Date('2026-09-07T03:00:00Z');
    expect(() => validateFutureMonth('2026-09', now)).toThrow(CollectionError);
    expect(() => validateFutureMonth('2027-09', now)).toThrow(CollectionError);
    expect(() => validateFutureMonth('2026-11', now)).not.toThrow();
  });
});

describe('local CLI failure protocol without network access', () => {
  it.each([
    [[], 'INVALID_ARGUMENTS'],
    [['--origin', 'ICN', '--origin', 'SIN', '--month', '2027-04'], 'INVALID_ARGUMENTS'],
    [['--origin', 'ICN', '--destination', 'SIN', '--month', '2027-13'], 'INVALID_MONTH'],
  ] as const)('prints one sanitized JSON error for invalid input %j', (args, code) => {
    let result: { stdout?: Buffer; stderr?: Buffer; status?: number } | undefined;
    try {
      execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/local-collect.ts', ...args], { stdio: 'pipe' });
    } catch (error) {
      result = error as typeof result;
    }
    expect(result?.status).toBe(1);
    expect(String(result?.stdout)).toBe('');
    const failure = JSON.parse(String(result?.stderr));
    expect(failure).toEqual({ code, message: expect.any(String) });
  });
});
