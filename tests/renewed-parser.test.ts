import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { CalendarParseError, parseCalendarHtml, type CalendarParseErrorCode } from '../src/parser.js';
import type { ParseCalendarOptions } from '../src/types.js';

// Real anonymous capture of the renewed (2026-11-26) booking UI: ICN -> JFK,
// one-way, January 2027. Days 1-3 render as no-seat cells; days 5-31 carry the
// observed empty placeholder `<li>` between cabin icons.
const fixture = readFileSync(
  new URL('./fixtures/public-calendar-icn-jfk-2027-01-renewed.html', import.meta.url),
  'utf8',
);
const options: ParseCalendarOptions = {
  origin: 'ICN',
  destination: 'JFK',
  month: '2027-01',
  sourceUpdatedAt: '2026-11-25T16:30:00+09:00',
  collectedAt: '2026-11-26T15:05:00+09:00',
};

// Mutations below are synthetic defensive cases, not observed airline day-cell states.
function mutate(change: ($: CheerioAPI) => void): string {
  const $ = load(fixture);
  change($);
  return $.html();
}

function expectFailure(html: string, code: CalendarParseErrorCode, settings = options): void {
  let thrown: unknown;
  try {
    parseCalendarHtml(html, settings);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CalendarParseError);
  expect((thrown as CalendarParseError).code).toBe(code);
}

describe('renewed anonymous ICN → JFK public calendar', () => {
  it('parses every date of the real January capture without inferring seat counts', () => {
    const result = parseCalendarHtml(fixture, options);
    expect(result).toMatchObject({
      ...options,
      tripType: 'ONE_WAY',
      source: 'KOREAN_AIR_PUBLIC_AWARD_CALENDAR',
    });
    expect(result.dates).toHaveLength(31);
    expect(result.dates.map(({ date }) => date)).toEqual(
      Array.from({ length: 31 }, (_, index) => `2027-01-${String(index + 1).padStart(2, '0')}`),
    );
    for (const date of result.dates) {
      expect(date).toMatchObject({
        availabilityType: 'PUBLIC_INDICATOR',
        availableSeatCount: null,
        premiumAward: false,
        prestigeAward: false,
        firstAward: false,
        firstAwardOrUpgrade: false,
        economyUpgrade: false,
        premiumUpgrade: false,
        firstUpgrade: false,
      });
    }
  });

  it('reads the observed no-seat cells as operated days with no availability', () => {
    const { dates } = parseCalendarHtml(fixture, options);
    const noSeat = dates.filter((date) => !date.economyAward && !date.prestigeUpgrade);
    expect(noSeat.map(({ date }) => date)).toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
    for (const date of noSeat) {
      expect(date).toMatchObject({ operatingStatus: 'OPERATED', firstAwardOrUpgrade: false });
    }
  });

  it('keeps economy awards and prestige upgrades apart without inventing award seats', () => {
    const { dates } = parseCalendarHtml(fixture, options);
    expect(dates.find((date) => date.date === '2027-01-04')).toMatchObject({
      economyAward: true,
      prestigeUpgrade: false,
    });
    expect(dates.filter((date) => date.prestigeUpgrade).map(({ date }) => date)).toEqual(
      Array.from({ length: 27 }, (_, index) => `2027-01-${String(index + 5).padStart(2, '0')}`),
    );
    expect(dates.some((date) => date.prestigeAward)).toBe(false);
    expect(dates.filter((date) => date.economyAward).map(({ date }) => date)).toHaveLength(28);
  });

  it('ignores empty Angular placeholder markers and the legend list', () => {
    expect(fixture).toContain('<li class="ng-star-inserted"></li>');
    expect(fixture).toContain('운항편 없음');
    const { dates } = parseCalendarHtml(fixture, options);
    expect(dates[4]).toMatchObject({ economyAward: true, prestigeUpgrade: true });
    expect(dates.every((date) => !date.firstAward && !date.firstUpgrade)).toBe(true);
  });
});

describe('renewed capture verification', () => {
  it('rejects a different destination or direction', () => {
    expectFailure(fixture, 'ROUTE_MISMATCH', { ...options, destination: 'LAX' });
    expectFailure(fixture, 'ROUTE_MISMATCH', { ...options, origin: 'JFK', destination: 'ICN' });
  });

  it('rejects a month label that differs from the requested month', () => {
    expectFailure(mutate(($) => { $('[data-milemap-month-label]').text('2027년 2월'); }), 'MONTH_MISMATCH');
    expectFailure(fixture, 'MONTH_MISMATCH', { ...options, month: '2027-02' });
  });

  it('rejects a weekday label that does not belong to the requested month', () => {
    expectFailure(mutate(($) => { $('#day_1 > .ui-flexible-date__selection > span._hidden').text(' 1일, 목요일 '); }), 'INVALID_DAY');
  });

  it('rejects missing or duplicated capture parts', () => {
    expectFailure('', 'STRUCTURE_CHANGED');
    expectFailure(`${fixture}\n${fixture}`, 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('[data-milemap-capture="renewed-1"] h1').remove(); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('[data-milemap-itinerary] em').last().remove(); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('[data-milemap-month-label]').remove(); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('#bonusCalendarTableWrapEl table').attr('class', 'bonus-calendar__table'); }), 'STRUCTURE_CHANGED');
  });
});

describe('renewed synthetic structural and marker defenses', () => {
  it('rejects duplicate dates instead of counting them as a complete month', () => {
    expectFailure(mutate(($) => { $('#day_31').replaceWith($('#day_30').clone()); }), 'DUPLICATE_DAY');
  });

  it('rejects a partial month even when its remaining dates look valid', () => {
    expectFailure(mutate(($) => { $('#day_31').remove(); }), 'INCOMPLETE_MONTH');
  });

  it('checks the month length and rejects January 32', () => {
    expectFailure(mutate(($) => {
      $('#day_31').attr('id', 'day_32');
      $('#day_32 .ui-flexible-date__cell-date').text('32');
      $('#day_32 > .ui-flexible-date__selection > span._hidden').text(' 32일, 일요일 ');
    }), 'INVALID_DAY');
  });

  it('rejects a hidden date and an unlabelled visible cell', () => {
    expectFailure(mutate(($) => { $('#day_4').attr('aria-hidden', 'true'); }), 'INVALID_DAY');
    expectFailure(mutate(($) => { $('#day_4').removeAttr('id'); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('#day_4 .ui-flexible-date__cell-date').text('05'); }), 'INVALID_DAY');
  });

  it('rejects an empty available cell instead of reporting no seats', () => {
    expectFailure(mutate(($) => { $('#day_4 ul.ui-flexible-date__icon-group').empty(); }), 'EMPTY_UNVERIFIED_STATE');
    expectFailure(mutate(($) => { $('#day_4 .ui-flexible-date__icon-box').empty(); }), 'EMPTY_UNVERIFIED_STATE');
  });

  it('rejects a no-seat cell without its state label or disabled shape', () => {
    expectFailure(mutate(($) => { $('#day_1 .ui-flexible-date__icon-box > span._hidden').remove(); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('#day_1').removeAttr('aria-disabled'); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('#day_1').removeClass('-no-seat'); }), 'STRUCTURE_CHANGED');
  });

  it('reads a labeled no-flight cell as not operated (synthetic: day cell not yet observed)', () => {
    const html = mutate(($) => {
      $('#day_1 .ui-flexible-date__icon-box > span._hidden').text(' 운항편 없음 ');
      $('#day_1').removeClass('-no-seat');
    });
    const first = parseCalendarHtml(html, options).dates[0];
    expect(first).toMatchObject({ operatingStatus: 'NOT_OPERATED', economyAward: false, prestigeUpgrade: false });
  });

  it('rejects an unavailable label mixed with availability markers', () => {
    expectFailure(mutate(($) => { $('#day_4 .ui-flexible-date__icon-box').append('<span class="_hidden"> &nbsp;좌석 없음</span>'); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('#day_4').addClass('-no-seat'); }), 'STRUCTURE_CHANGED');
    expectFailure(mutate(($) => { $('#day_4').attr('aria-disabled', 'true'); }), 'STRUCTURE_CHANGED');
  });

  it.each(['좌석 없음 말고', '일반석 좌석승급', '일등석 보너스', 'Unknown cabin'])(
    'rejects unobserved or malformed marker text: %s', (label) => {
      expectFailure(mutate(($) => {
        const marker = $('#day_4 ul.ui-flexible-date__icon-group li');
        marker.attr('class', 'ng-star-inserted');
        marker.find('span._hidden').text(label);
      }), 'UNKNOWN_MARKER');
    },
  );

  it('rejects a marker whose class contradicts its label', () => {
    expectFailure(mutate(($) => { $('#day_4 ul.ui-flexible-date__icon-group li').attr('class', '-prestige ng-star-inserted'); }), 'STRUCTURE_CHANGED');
  });

  it('rejects repeated markers', () => {
    expectFailure(mutate(($) => {
      $('#day_4 ul.ui-flexible-date__icon-group').append($('#day_4 ul.ui-flexible-date__icon-group li').first().clone());
    }), 'DUPLICATE_MARKER');
  });

  it.each([
    ['프리미엄석 보너스', '-premium', 'premiumAward'],
    ['프리미엄석 좌석승급', '-premium-upgrade', 'premiumUpgrade'],
    ['프레스티지석 보너스', '-prestige', 'prestigeAward'],
    ['프레스티지석 좌석승급', '-prestige-upgrade', 'prestigeUpgrade'],
  ] as const)('maps the observed legend %s through its cabin class', (label, token, field) => {
    const html = mutate(($) => {
      const marker = $('#day_4 ul.ui-flexible-date__icon-group li');
      marker.attr('class', `${token} ng-star-inserted`);
      marker.find('span._hidden').text(label);
      marker.find('kds-icon_1').attr('class', `--wds-ui ui-icon__host -legend-${token.slice(1)} -size16 -pc-size28 hydrated`);
    });
    const [first] = parseCalendarHtml(html, options).dates.slice(3);
    expect(first?.date).toBe('2027-01-04');
    expect(first?.[field]).toBe(true);
    expect(first?.economyAward).toBe(false);
    const trueFlags = Object.entries(first!).filter(([, value]) => value === true).map(([key]) => key);
    expect(trueFlags).toEqual([field]);
  });

  it('preserves the combined first-class marker as unknown award/upgrade', () => {
    const html = mutate(($) => {
      const marker = $('#day_4 ul.ui-flexible-date__icon-group li');
      marker.attr('class', '-first ng-star-inserted');
      marker.find('span._hidden').text('일등석 보너스/좌석승급');
      marker.find('kds-icon_1').attr('class', '--wds-ui ui-icon__host -legend-first -size16 -pc-size28 hydrated');
    });
    const dates = parseCalendarHtml(html, options).dates;
    const first = dates[3];
    expect(first).toMatchObject({
      date: '2027-01-04',
      firstAward: null,
      firstUpgrade: null,
      firstAwardOrUpgrade: true,
      economyAward: false,
    });
    expect(dates[4]?.economyAward).toBe(true);
  });

  it('preserves a missing source update time as null', () => {
    expect(parseCalendarHtml(fixture, { ...options, sourceUpdatedAt: null }).sourceUpdatedAt).toBeNull();
  });
});
