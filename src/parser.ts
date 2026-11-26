import { load, type CheerioAPI } from 'cheerio';
import type { AwardCalendar, AwardDate, ParseCalendarOptions } from './types.js';

export type CalendarParseErrorCode =
  | 'INVALID_MONTH'
  | 'UNSUPPORTED_ROUTE'
  | 'STRUCTURE_CHANGED'
  | 'ROUTE_MISMATCH'
  | 'MONTH_MISMATCH'
  | 'INVALID_DAY'
  | 'DUPLICATE_DAY'
  | 'INCOMPLETE_MONTH'
  | 'EMPTY_UNVERIFIED_STATE'
  | 'UNVERIFIED_UNAVAILABLE_STATE'
  | 'UNKNOWN_MARKER'
  | 'DUPLICATE_MARKER'
  | 'AMBIGUOUS_FIRST_CLASS';

export class CalendarParseError extends Error {
  constructor(public readonly code: CalendarParseErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CalendarParseError';
  }
}

const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim();

// Exact Korean legend labels observed on the official public calendar.
// First class is handled separately because its award/upgrade label is ambiguous.
const markerFields = new Map<string, keyof Pick<AwardDate,
  'economyAward' | 'premiumAward' | 'prestigeAward' | 'premiumUpgrade' | 'prestigeUpgrade'
>>([
  ['일반석 보너스', 'economyAward'],
  ['프리미엄석 보너스', 'premiumAward'],
  ['프레스티지석 보너스', 'prestigeAward'],
  ['프리미엄석 좌석승급', 'premiumUpgrade'],
  ['프레스티지석 좌석승급', 'prestigeUpgrade'],
]);

const FIRST_CLASS_COMBINED_MARKER = '일등석 보너스/좌석승급';
const NO_SEAT_MARKER = '좌석 없음';
const NO_FLIGHT_MARKER = '운항편 없음';

// Renewed (2026-11-26) booking UI: cabin icons carry a class token next to the
// same Korean label the legacy day cells used. The class is a cross-check only;
// the label stays authoritative so an unobserved class never invents a cabin.
const renewedMarkerClasses = new Map<string, string>([
  ['-economy', '일반석 보너스'],
  ['-premium', '프리미엄석 보너스'],
  ['-premium-upgrade', '프리미엄석 좌석승급'],
  ['-prestige', '프레스티지석 보너스'],
  ['-prestige-upgrade', '프레스티지석 좌석승급'],
  ['-first', FIRST_CLASS_COMBINED_MARKER],
]);

const RENEWED_TITLE = '보너스 좌석 상황';
const RENEWED_CAPTURE = '[data-milemap-capture="renewed-1"]';
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;

function weekdayLabel(month: string, day: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return WEEKDAY_LABELS[new Date(Date.UTC(year, number - 1, day)).getUTCDay()] as string;
}

function emptyDate(date: string): AwardDate {
  return {
    date,
    operatingStatus: 'OPERATED',
    availabilityType: 'PUBLIC_INDICATOR',
    availableSeatCount: null,
    economyAward: false,
    premiumAward: false,
    prestigeAward: false,
    firstAward: false,
    firstAwardOrUpgrade: false,
    economyUpgrade: false,
    premiumUpgrade: false,
    prestigeUpgrade: false,
    firstUpgrade: false,
  };
}

/**
 * Parse an observed anonymous one-way calendar DOM for an exact airport pair.
 * The caller must verify that all six UI filters are selected before capture.
 * Unsupported and unobserved states fail closed rather than inventing availability.
 *
 * Two official calendar layouts are supported:
 *  - LEGACY: a `[role="dialog"]` result with `table.bonus-calendar__table` day cells.
 *  - RENEWED: the 2026-11-26 booking UI, where the result renders in place with
 *    `table.ui-flexible-date__table` day cells. The collector captures it inside a
 *    `[data-milemap-capture="renewed-1"]` envelope that also carries the displayed
 *    route codes and month label read from the live page, because those live in
 *    shadow DOM that is not part of `outerHTML`.
 */
export function parseCalendarHtml(html: string, options: ParseCalendarOptions): AwardCalendar {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(options.month) || Number(options.month.slice(0, 4)) < 1000) {
    throw new CalendarParseError('INVALID_MONTH', 'Expected a valid YYYY-MM month.');
  }
  if (!/^[A-Z]{3}$/u.test(options.origin) || !/^[A-Z]{3}$/u.test(options.destination) || options.origin === options.destination) {
    throw new CalendarParseError('UNSUPPORTED_ROUTE', 'Expected two distinct uppercase three-letter airport codes.');
  }

  const $ = load(html);
  if ($('#bonusCalendarTableWrapEl table.ui-flexible-date__table').length > 0) {
    return parseRenewedCalendar($, options);
  }
  return parseLegacyCalendar($, options);
}

function parseLegacyCalendar($: CheerioAPI, options: ParseCalendarOptions): AwardCalendar {
  const dialog = $('[role="dialog"][aria-labelledby="modals-travelCalendar-title"]');
  if (dialog.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Expected exactly one public calendar dialog.');
  }
  const title = dialog.find('#modals-travelCalendar-title');
  if (title.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Calendar route heading is missing or duplicated.');
  }
  const routeCodes = normalize(title.text()).match(/\b[A-Z]{3}\b/gu) ?? [];
  if (routeCodes.length !== 2 || routeCodes[0] !== options.origin || routeCodes[1] !== options.destination) {
    throw new CalendarParseError('ROUTE_MISMATCH', 'Calendar heading does not match the requested route and direction.');
  }

  const monthButton = dialog.find('#travelCalendarListBtn');
  if (monthButton.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Calendar month selector is missing or duplicated.');
  }
  const displayedMonth = /^(\d{4})년 (\d{1,2})월$/u.exec(normalize(monthButton.text()));
  const [year, month] = options.month.split('-').map(Number) as [number, number];
  if (!displayedMonth || Number(displayedMonth[1]) !== year || Number(displayedMonth[2]) !== month) {
    throw new CalendarParseError('MONTH_MISMATCH', 'Displayed calendar month does not match the requested month.');
  }

  const tables = dialog.find('#bonusCalendarTableWrapEl table.bonus-calendar__table');
  if (tables.length !== 1 || tables.find('tbody').length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Expected exactly one calendar table and body.');
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const seenDays = new Set<number>();
  const dates: AwardDate[] = [];

  for (const element of tables.find('tbody td').toArray()) {
    const cell = $(element);
    const id = cell.attr('id');
    if (!id) {
      // The only observed padding cells are hidden, empty cells without IDs.
      if (cell.attr('aria-hidden') !== 'true' || normalize(cell.text()) !== '' || cell.children().length !== 0) {
        throw new CalendarParseError('STRUCTURE_CHANGED', 'Unexpected calendar cell without a date ID.');
      }
      continue;
    }
    const dayId = /^day_([1-9]\d?)$/u.exec(id);
    const day = Number(dayId?.[1]);
    if (!dayId || day < 1 || day > daysInMonth || cell.attr('aria-hidden') === 'true') {
      throw new CalendarParseError('INVALID_DAY', 'Calendar contains an invalid or hidden day.');
    }
    if (seenDays.has(day)) {
      throw new CalendarParseError('DUPLICATE_DAY', `Day ${day} appears more than once.`);
    }
    seenDays.add(day);

    const dayLabel = cell.find('.bonus-calendar__day > span[aria-hidden="true"]');
    if (dayLabel.length !== 1 || normalize(dayLabel.text()) !== String(day)) {
      throw new CalendarParseError('INVALID_DAY', `Day ${day} does not match its displayed date.`);
    }

    const icons = cell.find('.bonus-calendar__icons');
    const markerElements = icons.find('li');
    if (icons.length > 1) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has multiple marker containers.`);
    }
    // Exact no-seat day-cell structure observed in ICN→CDG November 2026.
    // Empty cells and the separately listed no-flight legend remain unsupported.
    const noSeat = cell.find('.bonus-calendar__day > span.ux-class-icon.-no-seat.-gray');
    const verifiedNoSeat = noSeat.length === 1 && normalize(noSeat.text()) === '좌석 없음';
    if (noSeat.length > 0 && (!verifiedNoSeat || markerElements.length > 0)) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has inconsistent no-seat and availability markers.`);
    }
    if (markerElements.length === 0 && !verifiedNoSeat) {
      throw new CalendarParseError('EMPTY_UNVERIFIED_STATE', `Day ${day} has no verified availability markers; unavailable-day DOM has not been observed.`);
    }

    const date = emptyDate(`${options.month}-${String(day).padStart(2, '0')}`);
    const seenMarkers = new Set<string>();
    for (const markerElement of markerElements.toArray()) {
      const marker = normalize($(markerElement).text());
      if (seenMarkers.has(marker)) {
        throw new CalendarParseError('DUPLICATE_MARKER', `Day ${day} repeats an availability marker.`);
      }
      seenMarkers.add(marker);
      if (marker === FIRST_CLASS_COMBINED_MARKER) {
        date.firstAward = null;
        date.firstUpgrade = null;
        date.firstAwardOrUpgrade = true;
        continue;
      }
      if (marker === NO_SEAT_MARKER || marker === NO_FLIGHT_MARKER) {
        throw new CalendarParseError('UNVERIFIED_UNAVAILABLE_STATE', `Day ${day} uses an unavailable-state label whose actual day-cell DOM has not been observed.`);
      }
      const field = markerFields.get(marker);
      if (!field) {
        throw new CalendarParseError('UNKNOWN_MARKER', `Day ${day} contains an unknown availability marker.`);
      }
      date[field] = true;
    }
    dates.push(date);
  }

  if (seenDays.size !== daysInMonth) {
    throw new CalendarParseError('INCOMPLETE_MONTH', `Expected ${daysInMonth} distinct days; received ${seenDays.size}.`);
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return {
    origin: options.origin,
    destination: options.destination,
    tripType: 'ONE_WAY',
    month: options.month,
    source: 'KOREAN_AIR_PUBLIC_AWARD_CALENDAR',
    sourceUpdatedAt: options.sourceUpdatedAt,
    collectedAt: options.collectedAt,
    dates,
  };
}

function parseRenewedCalendar($: CheerioAPI, options: ParseCalendarOptions): AwardCalendar {
  const capture = $(RENEWED_CAPTURE);
  if (capture.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Renewed calendar capture envelope is missing or duplicated.');
  }
  const title = capture.find('h1');
  if (title.length !== 1 || normalize(title.text()) !== RENEWED_TITLE) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Renewed result title is missing or unexpected.');
  }

  const routeCodes = capture.find('[data-milemap-itinerary] em').toArray().map((element) => normalize($(element).text()));
  if (routeCodes.length !== 2) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Displayed route codes are missing or duplicated.');
  }
  if (routeCodes[0] !== options.origin || routeCodes[1] !== options.destination) {
    throw new CalendarParseError('ROUTE_MISMATCH', 'Displayed route does not match the requested route and direction.');
  }

  const monthLabels = capture.find('[data-milemap-month-label]');
  if (monthLabels.length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Displayed month label is missing or duplicated.');
  }
  const [year, month] = options.month.split('-').map(Number) as [number, number];
  const displayedMonth = /^(\d{4})년 (\d{1,2})월$/u.exec(normalize(monthLabels.text()));
  if (!displayedMonth || Number(displayedMonth[1]) !== year || Number(displayedMonth[2]) !== month) {
    throw new CalendarParseError('MONTH_MISMATCH', 'Displayed calendar month does not match the requested month.');
  }

  const tables = capture.find('#bonusCalendarTableWrapEl table.ui-flexible-date__table');
  if (tables.length !== 1 || tables.find('tbody').length !== 1) {
    throw new CalendarParseError('STRUCTURE_CHANGED', 'Expected exactly one renewed calendar table and body.');
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const seenDays = new Set<number>();
  const dates: AwardDate[] = [];

  for (const element of tables.find('tbody td').toArray()) {
    const cell = $(element);
    const id = cell.attr('id');
    const classes = (cell.attr('class') ?? '').split(/\s+/u).filter(Boolean);
    if (!id) {
      // Observed padding cells: class `-empty`, aria-hidden, no content.
      if (!classes.includes('-empty') || cell.attr('aria-hidden') !== 'true'
        || normalize(cell.text()) !== '' || cell.children().length !== 0) {
        throw new CalendarParseError('STRUCTURE_CHANGED', 'Unexpected renewed calendar cell without a date ID.');
      }
      continue;
    }
    const dayId = /^day_([1-9]\d?)$/u.exec(id);
    const day = Number(dayId?.[1]);
    if (!dayId || day < 1 || day > daysInMonth || cell.attr('aria-hidden') === 'true') {
      throw new CalendarParseError('INVALID_DAY', 'Calendar contains an invalid or hidden day.');
    }
    if (seenDays.has(day)) {
      throw new CalendarParseError('DUPLICATE_DAY', `Day ${day} appears more than once.`);
    }
    seenDays.add(day);

    const cellDate = cell.find('.ui-flexible-date__cell-date');
    const cellDateText = /^0?([1-9]\d?)$/u.exec(normalize(cellDate.text()));
    if (cellDate.length !== 1 || !cellDateText || Number(cellDateText[1]) !== day) {
      throw new CalendarParseError('INVALID_DAY', `Day ${day} does not match its displayed date.`);
    }

    // The hidden label is "1일, 금요일". When present it must agree with the month
    // being parsed, which makes a wrong month fail instead of relabelling days.
    const dayLabel = cell.children('.ui-flexible-date__selection').children('span._hidden');
    if (dayLabel.length !== 1) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} is missing its accessibility label.`);
    }
    const dayLabelText = /^(\d{1,2})일, (일|월|화|수|목|금|토)요일$/u.exec(normalize(dayLabel.text()));
    if (!dayLabelText || Number(dayLabelText[1]) !== day
      || dayLabelText[2] !== weekdayLabel(options.month, day)) {
      throw new CalendarParseError('INVALID_DAY', `Day ${day} accessibility label does not match the requested month.`);
    }

    const iconBoxes = cell.find('.ui-flexible-date__icon-box');
    if (iconBoxes.length !== 1) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has an unexpected icon container.`);
    }
    const iconGroups = iconBoxes.find('ul.ui-flexible-date__icon-group');
    if (iconGroups.length > 1) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has multiple marker containers.`);
    }
    const noSeatClass = classes.includes('-no-seat');
    const disabled = cell.attr('aria-disabled') === 'true';

    // A disabled day labels itself once, as a direct child of the icon box.
    const stateLabels = iconBoxes.children('span._hidden').toArray().map((iconLabel) => normalize($(iconLabel).text())).filter(Boolean);
    if (stateLabels.length > 1) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} has multiple availability-state labels.`);
    }
    const stateLabel = stateLabels[0] ?? null;

    // Angular renders empty placeholder `<li>` elements between icons.
    const markers: { label: string; classes: string[] }[] = [];
    for (const markerElement of (iconGroups.length === 1 ? iconGroups.find('li') : $()).toArray()) {
      const marker = $(markerElement);
      const label = normalize(marker.find('span._hidden').first().text());
      if (label === '' && marker.children().length === 0) continue;
      markers.push({
        label,
        classes: (marker.attr('class') ?? '').split(/\s+/u).filter(Boolean),
      });
    }

    const date = emptyDate(`${options.month}-${String(day).padStart(2, '0')}`);
    if (markers.length === 0) {
      if (stateLabel === NO_SEAT_MARKER || stateLabel === NO_FLIGHT_MARKER) {
        // Observed in ICN→JFK 2027-01: `td -no-seat` with aria-disabled="true"
        // and a direct child hidden label `좌석 없음`. A no-flight day carries the
        // no-flight legend label instead; its exact day cell has not been observed,
        // so only this labeled, disabled shape is accepted.
        if (!disabled || (stateLabel === NO_SEAT_MARKER && !noSeatClass)) {
          throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} carries an unavailable label in an unverified cell shape.`);
        }
        date.operatingStatus = stateLabel === NO_FLIGHT_MARKER ? 'NOT_OPERATED' : 'OPERATED';
        dates.push(date);
        continue;
      }
      if (noSeatClass) {
        throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} is marked unavailable without its state label.`);
      }
      throw new CalendarParseError('EMPTY_UNVERIFIED_STATE', `Day ${day} has no verified availability markers.`);
    }

    if (stateLabel !== null || noSeatClass || disabled) {
      throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} mixes availability markers with an unavailable state.`);
    }

    const seenMarkers = new Set<string>();
    for (const marker of markers) {
      if (seenMarkers.has(marker.label)) {
        throw new CalendarParseError('DUPLICATE_MARKER', `Day ${day} repeats an availability marker.`);
      }
      seenMarkers.add(marker.label);
      const expectedLabel = marker.classes.map((token) => renewedMarkerClasses.get(token)).find(Boolean);
      if (expectedLabel !== undefined && expectedLabel !== marker.label) {
        throw new CalendarParseError('STRUCTURE_CHANGED', `Day ${day} marker class does not match its label.`);
      }
      if (marker.label === FIRST_CLASS_COMBINED_MARKER) {
        date.firstAward = null;
        date.firstUpgrade = null;
        date.firstAwardOrUpgrade = true;
        continue;
      }
      const field = markerFields.get(marker.label);
      if (!field) {
        throw new CalendarParseError('UNKNOWN_MARKER', `Day ${day} contains an unknown availability marker.`);
      }
      date[field] = true;
    }
    dates.push(date);
  }

  if (seenDays.size !== daysInMonth) {
    throw new CalendarParseError('INCOMPLETE_MONTH', `Expected ${daysInMonth} distinct days; received ${seenDays.size}.`);
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return {
    origin: options.origin,
    destination: options.destination,
    tripType: 'ONE_WAY',
    month: options.month,
    source: 'KOREAN_AIR_PUBLIC_AWARD_CALENDAR',
    sourceUpdatedAt: options.sourceUpdatedAt,
    collectedAt: options.collectedAt,
    dates,
  };
}
