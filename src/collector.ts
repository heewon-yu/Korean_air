import { chromium, type Locator, type Page } from 'playwright';
import { parseCalendarHtml } from './parser.js';

export const SOURCE_URL =
  'https://www.koreanair.com/booking/book-and-manage/award-seat-availability';
// Observed in the browser on 2026-09-07 and again on 2026-11-26. Only observe the
// UI's response; never replay it.
const OBSERVED_RESPONSE_PATH = '/api/hmp/bonusSeatView/bonusSeatView';
const FILTER_LABELS = [
  '일반석 보너스',
  '프리미엄석 보너스',
  '프리미엄석 좌석승급',
  '프레스티지석 보너스',
  '프레스티지석 좌석승급',
  '일등석 보너스/좌석승급',
] as const;

export class CollectionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CollectionError';
  }
}

export function parseSourceUpdatedAt(text: string): string | null {
  // Renewed wording (2026-11-26): "좌석 현황은 한국 시간 2026년 11월 26일 01:30 기준 정보로 …"
  // Legacy wording: "좌석 상황은 대한민국 시간(2026년 9월 7일 08:00) 기준 …"
  const match = text.match(
    /좌석 (?:현황|상황)은 (?:한국|대한민국) 시간 ?\(?(\d{4})년 (\d{1,2})월 (\d{1,2})일 (\d{2}):(\d{2})\)? ?기준/u,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const value = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour}:${minute}:00+09:00`;
  if (!Number.isFinite(Date.parse(value))) return null;
  return value;
}

export function validateFutureMonth(month: string, now = new Date()): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new CollectionError('INVALID_MONTH', '탑승월은 YYYY-MM 형식이어야 합니다.');
  }
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const start = Date.parse(`${month}-01T00:00:00+09:00`);
  const [year, number] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const end = Date.parse(`${month}-${lastDay}T00:00:00+09:00`);
  const currentDay = Date.parse(`${today}T00:00:00+09:00`);
  // This first collector intentionally handles complete future months only.
  if (start <= currentDay || end > currentDay + 359 * 86_400_000) {
    throw new CollectionError('MONTH_OUT_OF_RANGE', '향후 360일 안에 전체 날짜가 포함되는 미래 한 달을 선택하세요.');
  }
}

async function checkRestriction(page: Page, blockedStatus: number | null): Promise<void> {
  if (blockedStatus) {
    throw new CollectionError('ACCESS_RESTRICTED', `공개 조회 응답 HTTP ${blockedStatus}: 재시도 없이 중단했습니다.`);
  }
  // Generic visible error text only. Do not inspect or manipulate security internals.
  const text = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
  if (/access denied|접근이 차단|접속이 차단|비정상적인 접근|보안 문자|자동입력 방지|로봇이 아님|verify you are human/i.test(text)) {
    throw new CollectionError('USER_ACTION_REQUIRED', '접근 제한 또는 보안 확인 화면입니다. 자동 처리를 중단했습니다.');
  }
}

/**
 * Click a control the way a person does. The renewed booking UI renders its buttons
 * as KDS web components whose host can refuse a normal pointer click as covered by
 * its own shadow button; the fallback re-sends the same pointer click at the
 * element's center with hit-target checks skipped, never a script-dispatched event.
 */
async function clickFirst(locators: Locator[], description: string): Promise<void> {
  let clicked = false;
  let lastError: unknown;
  for (const locator of locators) {
    if (await locator.count() === 0) continue;
    const target = locator.first();
    try {
      await target.click({ timeout: 10_000 });
      clicked = true;
      break;
    } catch (error) {
      lastError = error;
      try {
        await target.click({ force: true, timeout: 10_000 });
        clicked = true;
        break;
      } catch (forcedError) {
        lastError = forcedError;
      }
    }
  }
  if (!clicked) {
    throw new CollectionError('STRUCTURE_CHANGED', `${description} 컨트롤을 찾아 조작하지 못했습니다: ${String(lastError)}`);
  }
}

function describeResponse(value: unknown) {
  const root = value as { flightList?: { flightDetailList?: Record<string, unknown>[] }[] };
  const dates = Array.isArray(root?.flightList) ? root.flightList : [];
  const records = dates.flatMap((day) => Array.isArray(day.flightDetailList) ? day.flightDetailList : []);
  return {
    endpoint: OBSERVED_RESPONSE_PATH,
    method: 'POST',
    dayCount: dates.length,
    statusRecordCount: records.length,
    fields: [...new Set(records.flatMap((record) => Object.keys(record)))].sort(),
    availableSeatTypes: [...new Set(records.map((record) => typeof record.availableSeat))],
    numericFields: [...new Set(records.flatMap((record) =>
      Object.entries(record).filter(([, value]) => typeof value === 'number').map(([key]) => key)))],
    note: '상태 항목 개수는 잔여 좌석 수가 아닙니다. 실제 날짜별 결과는 화면 DOM에서 추출합니다.',
  };
}

/**
 * The renewed result renders route codes and the selected month inside KDS shadow
 * roots, which `outerHTML` does not serialize. This wrapper carries those two values
 * read from the live page next to the untouched table and legend markup, so the
 * parser can verify route and month from the same document it parses.
 */
async function captureRenewedCalendar(page: Page): Promise<string> {
  return page.evaluate(() => {
    const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (character) => {
      switch (character) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        default: return '&quot;';
      }
    });
    const table = document.querySelector('#bonusCalendarTableWrapEl');
    if (!table) return '';
    const title = [...document.querySelectorAll('h1')]
      .find((heading) => (heading.textContent ?? '').trim() === '보너스 좌석 상황');
    const itinerary = document.querySelector('kds-itinerary_1');
    const codes = itinerary?.shadowRoot
      ? [...itinerary.shadowRoot.querySelectorAll('em.ui-itinerary__airport-code-tag')]
        .map((code) => (code.textContent ?? '').trim())
      : [];
    const monthHost = document.querySelector('kds-menu-button_1');
    const monthLabel = monthHost?.shadowRoot
      ?.querySelector('button span:not(._hidden)')?.textContent?.trim() ?? '';
    const legends = document.querySelector('.bonus-calendar__legends-box');
    return '<div data-milemap-capture="renewed-1">'
      + `<h1>${escapeHtml((title?.textContent ?? '').trim())}</h1>`
      + `<p data-milemap-itinerary>${codes.map((code) => `<em>${escapeHtml(code)}</em>`).join('')}</p>`
      + `<p data-milemap-month-label>${escapeHtml(monthLabel)}</p>`
      + table.outerHTML
      + (legends ? legends.outerHTML : '')
      + '</div>';
  });
}

export interface CollectionOptions {
  origin?: string;
  destination?: string;
  /** The localhost application only needs calendar data, never page/session artifacts. */
  captureArtifacts?: boolean;
}

export function validateRoute(origin: string, destination: string): void {
  if (!/^[A-Z]{3}$/u.test(origin) || !/^[A-Z]{3}$/u.test(destination) || origin === destination) {
    throw new CollectionError('INVALID_ROUTE', '서로 다른 출발·도착 공항의 영문 3자리 코드를 입력하세요.');
  }
}

async function launchBrowser(headless: boolean) {
  try {
    // A locally installed Chrome is the verified study browser.
    return await chromium.launch({ channel: 'chrome', headless });
  } catch (error) {
    // The collector container installs Playwright's bundled Chromium only.
    return await chromium.launch({ headless });
  }
}

export async function collectMonth(month: string, headless = false, options: CollectionOptions = {}) {
  validateFutureMonth(month);
  const { origin = 'ICN', destination = 'JFK', captureArtifacts = true } = options;
  validateRoute(origin, destination);
  const browser = await launchBrowser(headless);
  const context = await browser.newContext({
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  let blockedStatus: number | null = null;
  const requests: { method: string; path: string; status: number }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== 'koreanair.com' && !url.hostname.endsWith('.koreanair.com')) return;
    // Stop on a restriction from any first-party resource, including airport lookups.
    if ([401, 403, 429].includes(response.status())) blockedStatus = response.status();
    const mainDocument = response.request().isNavigationRequest() && response.frame() === page.mainFrame();
    if (url.pathname === OBSERVED_RESPONSE_PATH || mainDocument) {
      requests.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });
  try {
    await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await checkRestriction(page, blockedStatus);
    const oneWayRadio = page.getByRole('radio', { name: '편도', exact: true });
    await oneWayRadio.or(page.locator('#bonusTripTypeLabel_OW')).first().waitFor({ state: 'visible', timeout: 30_000 });
    const consent = page.getByRole('button', { name: '필수 쿠키만 허용', exact: true });
    try {
      await consent.waitFor({ state: 'visible', timeout: 8_000 });
      await consent.click();
    } catch (error) {
      // Some regions do not present this banner. Continue only with an accessible form.
      if (!(await oneWayRadio.isVisible())) throw error;
    }
    await checkRestriction(page, blockedStatus);
    const sourceUpdatedAt = parseSourceUpdatedAt(await page.locator('body').innerText());

    // Trip type: renewed UI uses KDS chip radios; the legacy UI exposed these ids.
    await clickFirst(
      [oneWayRadio, page.locator('#bonusTripTypeLabel_OW')],
      '편도 선택',
    );
    const oneWayChecked = await oneWayRadio.isChecked()
      .catch(() => page.locator('#bonusTripType_OW').isChecked());
    if (!oneWayChecked) {
      throw new CollectionError('STRUCTURE_CHANGED', '편도 선택 상태를 확인하지 못했습니다.');
    }

    await clickFirst([page.getByRole('button', { name: 'From 출발지', exact: true })], '출발지 선택');
    // The observed autocomplete requires per-key events; fill alone did not show
    // candidates. Preserve the verified UI entry method for every airport code.
    await page.getByRole('combobox', { name: '출발지 검색', exact: true }).pressSequentially(origin, { delay: 60 });
    await clickFirst([page.getByRole('option', { name: new RegExp(`\\b${origin}\\b`, 'u') })], `${origin} 출발지 옵션`);
    await checkRestriction(page, blockedStatus);

    await clickFirst([page.getByRole('button', { name: 'To 도착지', exact: true })], '도착지 선택');
    await page.getByRole('combobox', { name: '도착지 검색', exact: true }).pressSequentially(destination, { delay: 60 });
    await clickFirst([page.getByRole('option', { name: new RegExp(`\\b${destination}\\b`, 'u') })], `${destination} 도착지 옵션`);
    await checkRestriction(page, blockedStatus);

    // Month picker: renewed UI opens it from the "탑승월 가는 달" button, legacy from #seatCalendarBtn.
    await clickFirst(
      [page.getByRole('button', { name: /^탑승월/u }), page.locator('#seatCalendarBtn')],
      '탑승월 선택',
    );
    const [year, number] = month.split('-');
    await clickFirst(
      [page.getByRole('group', { name: year, exact: true }).getByRole('button', { name: `${Number(number)}월`, exact: true })],
      `${month} 월 선택`,
    );
    await clickFirst([page.getByRole('button', { name: '선택', exact: true })], '탑승월 확정');
    await checkRestriction(page, blockedStatus);

    // A single monthly search. There is no day-by-day navigation or direct API client.
    const responseObservation = captureArtifacts ? page.waitForResponse(
      (response) => new URL(response.url()).pathname === OBSERVED_RESPONSE_PATH,
      { timeout: 25_000 },
    ).then(async (response) => response.ok() ? describeResponse(await response.json()) : null).catch(() => null) : Promise.resolve(null);
    await clickFirst([page.getByRole('button', { name: '조회', exact: true })], '조회');
    const legacyDialog = page.locator('[role="dialog"][aria-labelledby="modals-travelCalendar-title"]');
    await page.locator('#bonusCalendarTableWrapEl tbody td[id^="day_"]').first().waitFor({ timeout: 30_000 });
    await checkRestriction(page, blockedStatus);

    // Every cabin filter must be shown, otherwise the calendar hides seat types.
    await clickFirst(
      [page.getByRole('button', { name: '좌석 필터', exact: true }), page.locator('#bonusFilterBtn')],
      '좌석 필터',
    );
    const filter = page.getByRole('dialog', { name: '보너스 좌석 필터', exact: true }).or(
      page.locator('[role="dialog"]').filter({
        has: page.getByRole('heading', { name: '보너스 좌석 필터', exact: true }),
      }),
    ).first();
    await filter.waitFor({ timeout: 15_000 });
    if (await filter.getByRole('checkbox').count() !== FILTER_LABELS.length) {
      throw new CollectionError('STRUCTURE_CHANGED', '좌석 필터 구조가 변경되었습니다.');
    }
    for (const name of FILTER_LABELS) {
      if (!(await filter.getByRole('checkbox', { name, exact: true }).isChecked())) {
        throw new CollectionError('FILTERED_RESULT', '일부 좌석 종류가 숨겨져 있어 수집을 중단했습니다.');
      }
    }
    await clickFirst([filter.getByRole('button', { name: '닫기', exact: true })], '좌석 필터 닫기');

    const renewed = await page.locator('#bonusCalendarTableWrapEl table.ui-flexible-date__table').count() > 0;
    const html = renewed
      ? await captureRenewedCalendar(page)
      : await legacyDialog.evaluate((element) => element.outerHTML);
    const data = parseCalendarHtml(html, {
      origin, destination, month, sourceUpdatedAt, collectedAt: new Date().toISOString(),
    });
    const resultRegion = renewed
      ? page.locator('.full-modal-dialog__main-document')
      : legacyDialog;
    const screenshot = captureArtifacts ? await resultRegion.first().screenshot() : Buffer.alloc(0);
    return {
      data,
      html: captureArtifacts ? html : '',
      screenshot,
      evidence: {
        sourceUrl: SOURCE_URL, sourceDescription: '대한항공 공개 현황 기준',
        loggedIn: false, persistedSessionUsed: false,
        method: renewed ? 'MONTHLY_DOM_RENEWED' : 'MONTHLY_DOM',
        requests, responseObservation: await responseObservation,
        cookies: captureArtifacts ? (await context.cookies()).map(({ name, domain, httpOnly, secure, sameSite }) =>
          ({ name, domain, httpOnly, secure, sameSite })) : [],
      },
    };
  } catch (error) {
    await checkRestriction(page, blockedStatus);
    throw error;
  } finally {
    await browser.close();
  }
}
