// Visa appointment monitor for the Embassy of Japan in Colombia.
// Watches the target date window (June + first week of July), and the moment a day
// opens (FULL -> OPEN), it brings the browser to the front on the booking page,
// fires a WhatsApp + local alarm, and stops so you can confirm by hand.
//
// It NEVER submits a reservation or fills your personal data. "Avisar y dejar listo".
//
// Usage:
//   node --env-file=.env bot.mjs              # run forever (overnight)
//   node --env-file=.env bot.mjs --once       # single check (for testing)
//   node --env-file=.env bot.mjs --test-alert # fire a test alert and exit
import { chromium } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { alertOpen, testAlert } from './notify.mjs';

const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const LOCK = new URL('./FOUND.lock', import.meta.url).pathname;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const log = (...a) => console.log(new Date().toLocaleString('es-CO'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inRange(y, m, d) {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return iso >= CONFIG.targetFrom && iso <= CONFIG.targetTo;
}

// Read the currently displayed month. Availability is signalled by the day's ICON:
//   icon_disabled.svg = full (x)   |   icon_circle.svg (any non-disabled) = available (o)   |   no icon = no service
export async function readMonth(page) {
  return await page.evaluate(() => {
    const header = (document.querySelector('.date')?.innerText || '').replace(/\s+/g, ' ').trim();
    const mm = header.match(/(\d{4})\D+(\d{1,2})/);
    const year = mm ? +mm[1] : null;
    const month = mm ? +mm[2] : null;
    const days = [];
    for (const c of document.querySelectorAll('.sc_cal_month_itemlist')) {
      const num = c.querySelector('.sc_cal_date')?.innerText.trim();
      if (!num) continue;
      const img = c.querySelector('.c_cal_time_cell img');
      const icon = img ? (img.getAttribute('src') || '').split('/').pop().split('?')[0] : null;
      const open = !!icon && !icon.includes('disabled'); // has an icon that is not the "full" one
      const full = !!icon && icon.includes('disabled');
      days.push({ day: +num, open, full, icon });
    }
    return { header, year, month, days };
  });
}

async function gotoCalendar(page) {
  await page.goto(CONFIG.calendarUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1200);
  await ensureMonthView(page);
}

// The site remembers the last view (day/week/month) in the session; month readings
// assume the month view, so force it back if a verification left us on the day view.
async function ensureMonthView(page) {
  try {
    const btn = page.locator('a.js_change[data-value="month"]').first();
    if (!(await btn.count())) return;
    if (await btn.evaluate((el) => el.classList.contains('active'))) return;
    await Promise.all([
      page.waitForResponse((r) => /reservations\/calendar/.test(r.url()), { timeout: 10000 }).catch(() => null),
      btn.click(),
    ]);
    await page.waitForTimeout(1200);
  } catch { /* best effort */ }
}

// Guarantee the applicants dropdown equals `n` before reading availability.
// This matters for correctness: a day with only 1 free slot must NOT count as open for 2.
// Returns the verified value in the DOM (string), or null if it could not be set.
async function ensureStock(page, n) {
  try {
    await page.waitForSelector('#stock', { timeout: 8000 });
    const want = String(n);
    if ((await page.$eval('#stock', (el) => el.value)) === want) return want;
    await Promise.all([
      // The applicants selector triggers a different reload per view: a calendar POST on
      // the month view, interval/staff-stock requests on the day view.
      page.waitForResponse((r) => /reservations\/(calendar|interval-stock|staff-stock)/.test(r.url()), { timeout: 6000 }).catch(() => null),
      page.selectOption('#stock', want),
    ]);
    await page.waitForTimeout(900);
    const after = await page.$eval('#stock', (el) => el.value).catch(() => null);
    if (after !== want) log(`  [stock] AVISO: el sitio quedo en "${after}", esperaba "${want}"`);
    return after;
  } catch (e) {
    log('  [stock] no pude fijar solicitantes:', e.message);
    return null;
  }
}

// Months covered by the target window, e.g. [{year:2026,month:6},{year:2026,month:7}].
function monthsInRange(fromIso, toIso) {
  const [fy, fm] = fromIso.split('-').map(Number);
  const [ty, tm] = toIso.split('-').map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) { out.push({ year: y, month: m }); if (++m > 12) { m = 1; y++; } }
  return out;
}

// Read which month the calendar is currently showing.
async function currentMonth(page) {
  return await page.evaluate(() => {
    const h = (document.querySelector('.date')?.innerText || '').replace(/\s+/g, ' ');
    const mm = h.match(/(\d{4})\D+(\d{1,2})/);
    return mm ? { year: +mm[1], month: +mm[2], header: h.trim() } : null;
  });
}

// Navigate deterministically to a given month using prev/next (AJAX reloads).
// Robust regardless of which month the session starts on.
async function goToMonth(page, year, month) {
  for (let i = 0; i < 18; i++) {
    const cur = await currentMonth(page);
    if (!cur) return false;
    if (cur.year === year && cur.month === month) return true;
    const forward = cur.year < year || (cur.year === year && cur.month < month);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => /reservations\/calendar/.test(r.url()) && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
      page.click(forward ? 'a.next01' : 'a.prev01').catch(() => {}),
    ]);
    await page.waitForTimeout(1000);
    if (!resp) return false;
  }
  return false;
}

function openInRange(m) {
  if (!m.year) return [];
  return m.days
    .filter((d) => d.open && inRange(m.year, m.month, d.day))
    .map((d) => ({ ...d, year: m.year, month: m.month }));
}

// Best-effort: click the open day to advance toward the form (no data, no submit).
// Tries known reserve links, then falls back to the availability icon / cell.
async function clickDay(page, day) {
  const cell = page.locator('.sc_cal_month_itemlist')
    .filter({ has: page.locator(`.sc_cal_date:text-is("${day}")`) });
  const candidates = [
    cell.locator('a.js_move_reserve_for_day, a.js_move_reserve'),
    cell.locator('.c_cal_time_cell a'),
    cell.locator('.c_cal_time_cell img'),
    cell.locator('.c_cal_time_cell'),
  ];
  for (const loc of candidates) {
    if ((await loc.count()) > 0) {
      await loc.first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

// Read bookable time slots on the day view for the CURRENT applicants selection.
// A bookable slot renders as a LINK (to reservations/option) with "残 N件"; a slot
// without enough capacity for the selected applicants is plain grey text "残 0件".
export async function readDaySlots(page) {
  return await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(/残\s*(\d+)\s*件/);
      const isOption = href.includes('reservations/option');
      if (!isOption && !(m && +m[1] > 0)) continue;
      let time = '';
      const t = href.match(/time_from=([^&]+)/);
      if (t) time = decodeURIComponent(t[1]);
      if (!time) {
        const row = a.closest('tr');
        const tm = row && (row.innerText.match(/\d{1,2}:\d{2}/) || []);
        if (tm && tm[0]) time = tm[0];
      }
      const key = `${time}|${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ time, remaining: m ? +m[1] : null });
    }
    return out;
  });
}

// Level-2 verification. The month circle only means "some capacity exists"; it does NOT
// guarantee a slot for the wanted applicants (e.g. 1 seat left but 2 needed). Open the day,
// re-verify the applicants selector there, and require a bookable slot before alerting.
async function verifyAndAlert(page, hits) {
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const dateLabel = `${hit.year}-${String(hit.month).padStart(2, '0')}-${String(hit.day).padStart(2, '0')}`;
    try {
      if (i > 0) await gotoCalendar(page);
      await goToMonth(page, hit.year, hit.month);
      await ensureStock(page);
      const clicked = await clickDay(page, hit.day);
      if (!page.url().includes('/reservations/calendar')) {
        log(`  ${dateLabel}: el click salto directo al flujo de reserva. Alerto.`);
        await handleOpen(page, hit, [], 'Quedaste dentro del flujo de reserva, revisa el navegador');
        return true;
      }
      const onDayView = await page.evaluate(() => /残\s*\d+\s*件/.test(document.body ? document.body.innerText : ''));
      if (!clicked || !onDayView) {
        log(`  ${dateLabel}: no pude abrir la lista de franjas (click=${clicked}). Alerto por precaucion.`);
        await handleOpen(page, hit, [], 'No pude verificar las franjas, revisa el navegador');
        return true;
      }
      // Try each accepted applicants count in priority order on the day view (it has
      // its own #stock selector; changing it reloads the slot list).
      for (const n of CONFIG.applicantsList) {
        await ensureStock(page, n);
        const slots = await readDaySlots(page);
        if (slots.length) {
          const maxWanted = Math.max(...CONFIG.applicantsList);
          const note = n < maxWanted ? `Cupo SOLO para ${n} persona(s) en esta franja, no para ${maxWanted}` : '';
          log(`  ${dateLabel}: ${slots.length} franja(s) con cupo para ${n}: ${slots.map((s) => s.time || '?').join(', ')}`);
          await handleOpen(page, hit, slots, note, n);
          return true;
        }
      }
      log(`  ${dateLabel}: circulo en el mes pero NINGUNA franja admite ${CONFIG.applicantsLabel} solicitante(s) todavia. No alerto.`);
      await page.screenshot({ path: `${SHOTS}nofit-${dateLabel}.png`, fullPage: true }).catch(() => {});
    } catch (e) {
      log(`  ${dateLabel}: error verificando franjas (${e.message}). Alerto por precaucion.`);
      await handleOpen(page, hit, [], 'Fallo la verificacion de franjas, revisa el navegador');
      return true;
    }
  }
  return false;
}

async function handleOpen(page, hit, slots = [], note = '', applicants = CONFIG.applicantsLabel) {
  const dateLabel = `${hit.year}-${String(hit.month).padStart(2, '0')}-${String(hit.day).padStart(2, '0')}`;
  const timeLabel = slots.map((s) => s.time).filter(Boolean).slice(0, 4).join(', ');
  log(`🟢 CUPO DETECTADO: ${dateLabel}${timeLabel ? ` (${timeLabel})` : ''} para ${applicants} solicitante(s). Avisando...`);
  await page.bringToFront().catch(() => {});
  await page.screenshot({ path: `${SHOTS}FOUND-${dateLabel}.png`, fullPage: true }).catch(() => {});
  await alertOpen(CONFIG, { dateLabel, timeLabel, note, applicants });
  writeFileSync(LOCK, `FOUND ${dateLabel} ${timeLabel} for ${applicants} at ${new Date().toISOString()}\n`.replace('  ', ' '));
  log('  Alerta enviada. El navegador queda en la lista de franjas. Termina la reserva a mano.');
}

// Visible status banner so you can trust the bot is watching the whole range,
// no matter which month the calendar happens to be showing.
async function showBanner(page, confirmedCount, note = '') {
  const txt = `🤖 Bot activo | busca para ${CONFIG.applicantsLabel} | Vigilando ${CONFIG.targetFrom} a ${CONFIG.targetTo} | `
    + `ultimo chequeo ${new Date().toLocaleTimeString('es-CO')} | cupos confirmados: ${confirmedCount}`
    + (note ? ` | ${note}` : '')
    + ` | proximo chequeo en ~${Math.round(CONFIG.pollIntervalMs / 1000)}s`;
  await page.evaluate((t) => {
    let el = document.getElementById('__bot_banner__');
    if (!el) { el = document.createElement('div'); el.id = '__bot_banner__'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0a8f3c;'
      + 'color:#fff;font:13px/1.5 -apple-system,system-ui,sans-serif;padding:8px 12px;text-align:center;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.35)';
    el.textContent = t;
  }, txt).catch(() => {});
}

// Create a fresh browser/context/page. Used at startup and to auto-recover.
export async function launchBrowser() {
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const ctx = await browser.newContext({
    locale: 'es-CO', timezoneId: 'America/Bogota', userAgent: UA, viewport: { width: 1366, height: 900 },
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

// Return a live state; if the window/browser was closed (or crashed), relaunch it.
// Keeps an overnight run alive even if the visible window is closed by accident.
export async function ensureAlive(state) {
  const alive = state && state.browser && state.browser.isConnected() && state.page && !state.page.isClosed();
  if (alive) return state;
  if (state && state.browser) { try { await state.browser.close(); } catch { /* already gone */ } }
  log('  navegador no disponible (ventana cerrada o crash). Relanzando...');
  return await launchBrowser();
}

async function main() {
  const arg = process.argv[2] || '';
  if (arg === '--test-alert') { await testAlert(CONFIG); return; }
  const once = arg === '--once';

  if (existsSync(LOCK) && !once) {
    log('Existe FOUND.lock de una corrida previa. Borralo para reactivar el bot:', LOCK);
    return;
  }

  log('=== Bot de cita de visa | Embajada de Japon en Colombia ===');
  log(`Rango objetivo : ${CONFIG.targetFrom} -> ${CONFIG.targetTo}  | solicitantes: ${CONFIG.applicantsLabel} (prioridad: ${CONFIG.applicantsList[0]})`);
  log(`Polling        : ${CONFIG.pollIntervalMs / 1000}s +/- ${CONFIG.pollJitterMs / 1000}s  | headless: ${CONFIG.headless}`);
  log(`WhatsApp       : ${CONFIG.whatsapp.phone ? 'configurado (' + CONFIG.whatsapp.phone + ')' : 'NO configurado'}`);

  mkdirSync(SHOTS, { recursive: true });
  let state = await launchBrowser();

  const targets = monthsInRange(CONFIG.targetFrom, CONFIG.targetTo);
  log(`Meses a vigilar: ${targets.map((t) => `${t.year}-${String(t.month).padStart(2, '0')}`).join(', ')}`);
  const stat = (m) => `abiertos ${m.days.filter((d) => d.open).length}/${m.days.filter((d) => d.open || d.full).length} con servicio`;

  let cycle = 0;
  let found = false;
  do {
    cycle++;
    try {
      state = await ensureAlive(state); // relaunch the browser if the window was closed
      const { page } = state;
      await gotoCalendar(page);
      // Month-level reading uses the MOST permissive count (min): the circle is only a
      // trigger, and the day-level check decides how many applicants actually fit.
      let stockDom = await ensureStock(page, CONFIG.applicantsMin);
      const parts = [];
      const hits = [];
      for (const t of targets) {
        const reached = await goToMonth(page, t.year, t.month);
        if (!reached) { parts.push(`${t.year}-${String(t.month).padStart(2, '0')}: no navegable`); continue; }
        stockDom = await ensureStock(page, CONFIG.applicantsMin);
        const m = await readMonth(page);
        hits.push(...openInRange(m));
        parts.push(`${m.header} (${stat(m)})`);
      }
      log(`ciclo ${cycle} [busca para: ${CONFIG.applicantsLabel} | stock lectura: ${stockDom}]: ${parts.join(' | ')} | en tu rango: ${hits.length}`);

      let nofitNote = '';
      if (hits.length) {
        const dates = hits.map((h) => `${h.year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`).join(', ');
        log(`  candidatos con circulo en rango: ${dates}. Verificando franjas por hora...`);
        if (await verifyAndAlert(page, hits)) { found = true; break; }
        nofitNote = `circulo en ${dates} pero sin franja para ${CONFIG.applicantsLabel} aun`;
        await gotoCalendar(page); // verification leaves the day view; reset for the resting state
      }

      // Rest on the first target month and show a status banner you can trust.
      await goToMonth(page, targets[0].year, targets[0].month).catch(() => {});
      await showBanner(page, 0, nofitNote);
    } catch (e) {
      log('error en ciclo (se reintenta el proximo ciclo):', e.message);
      await state.page?.screenshot({ path: `${SHOTS}error-cycle-${cycle}.png`, fullPage: true }).catch(() => {});
    }
    if (once) break;
    const wait = CONFIG.pollIntervalMs + Math.floor((Math.random() * 2 - 1) * CONFIG.pollJitterMs);
    await sleep(Math.max(20_000, wait));
  } while (!found);

  if (found) {
    log('Cupo encontrado. Dejo el navegador ABIERTO. Cierra este proceso con Ctrl+C al terminar.');
    await new Promise(() => {}); // keep alive so the open window stays usable
  } else {
    await state.browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}
