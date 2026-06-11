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

// Read the currently displayed month: a day is OPEN if its cell has a reserve link.
async function readMonth(page) {
  return await page.evaluate(() => {
    const header = (document.querySelector('.date')?.innerText || '').replace(/\s+/g, ' ').trim();
    const mm = header.match(/(\d{4})\D+(\d{1,2})/);
    const year = mm ? +mm[1] : null;
    const month = mm ? +mm[2] : null;
    const days = [];
    for (const c of document.querySelectorAll('.sc_cal_month_itemlist')) {
      const num = c.querySelector('.sc_cal_date')?.innerText.trim();
      if (!num) continue;
      const open = !!c.querySelector('a.js_move_reserve_for_day, a.js_move_reserve');
      const img = c.querySelector('.c_cal_time_cell img');
      const icon = img ? (img.getAttribute('src') || '').split('/').pop().split('?')[0] : null;
      days.push({ day: +num, open, full: !!(icon && icon.includes('disabled')) });
    }
    return { header, year, month, days };
  });
}

async function gotoCalendar(page) {
  await page.goto(CONFIG.calendarUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1200);
}

// Guarantee the applicants dropdown equals CONFIG.applicants before reading availability.
// This matters for correctness: a day with only 1 free slot must NOT count as open for 2.
// Returns the verified value in the DOM (string), or null if it could not be set.
async function ensureStock(page) {
  try {
    await page.waitForSelector('#stock', { timeout: 8000 });
    const want = String(CONFIG.applicants);
    if ((await page.$eval('#stock', (el) => el.value)) === want) return want;
    await Promise.all([
      page.waitForResponse((r) => /reservations\/calendar/.test(r.url()) && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
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
async function clickDay(page, day) {
  const cell = page.locator('.sc_cal_month_itemlist')
    .filter({ has: page.locator(`.sc_cal_date:text-is("${day}")`) });
  const link = cell.locator('a.js_move_reserve_for_day, a.js_move_reserve').first();
  await link.click({ timeout: 8000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
}

async function handleOpen(page, hit) {
  const dateLabel = `${hit.year}-${String(hit.month).padStart(2, '0')}-${String(hit.day).padStart(2, '0')}`;
  log(`🟢 CUPO DETECTADO: ${dateLabel}. Activando reserva asistida...`);
  await page.bringToFront().catch(() => {});
  await page.screenshot({ path: `${SHOTS}FOUND-${dateLabel}.png`, fullPage: true }).catch(() => {});
  try {
    await clickDay(page, hit.day);
    await page.screenshot({ path: `${SHOTS}FOUND-${dateLabel}-step2.png`, fullPage: true }).catch(() => {});
    log('  Navegador avanzado al siguiente paso. Completa hora/datos y CONFIRMA.');
  } catch (e) {
    log('  No pude auto-avanzar (quedo en el calendario, clic manual en el dia verde):', e.message);
  }
  await alertOpen(CONFIG, { dateLabel, timeLabel: '' });
  writeFileSync(LOCK, `FOUND ${dateLabel} at ${new Date().toISOString()}\n`);
  log('  Alerta enviada. Dejo el navegador abierto. Termina la reserva a mano.');
}

// Visible status banner so you can trust the bot is watching the whole range,
// no matter which month the calendar happens to be showing.
async function showBanner(page, hitCount) {
  const txt = `🤖 Bot activo | ${CONFIG.applicants} solicitantes | Vigilando ${CONFIG.targetFrom} a ${CONFIG.targetTo} | `
    + `ultimo chequeo ${new Date().toLocaleTimeString('es-CO')} | cupos en tu rango: ${hitCount} | `
    + `proximo chequeo en ~${Math.round(CONFIG.pollIntervalMs / 1000)}s`;
  await page.evaluate((t) => {
    let el = document.getElementById('__bot_banner__');
    if (!el) { el = document.createElement('div'); el.id = '__bot_banner__'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0a8f3c;'
      + 'color:#fff;font:13px/1.5 -apple-system,system-ui,sans-serif;padding:8px 12px;text-align:center;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.35)';
    el.textContent = t;
  }, txt).catch(() => {});
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
  log(`Rango objetivo : ${CONFIG.targetFrom} -> ${CONFIG.targetTo}  | solicitantes: ${CONFIG.applicants}`);
  log(`Polling        : ${CONFIG.pollIntervalMs / 1000}s +/- ${CONFIG.pollJitterMs / 1000}s  | headless: ${CONFIG.headless}`);
  log(`WhatsApp       : ${CONFIG.whatsapp.phone ? 'configurado (' + CONFIG.whatsapp.phone + ')' : 'NO configurado'}`);

  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const ctx = await browser.newContext({
    locale: 'es-CO', timezoneId: 'America/Bogota', userAgent: UA, viewport: { width: 1366, height: 900 },
  });
  const page = await ctx.newPage();

  const targets = monthsInRange(CONFIG.targetFrom, CONFIG.targetTo);
  log(`Meses a vigilar: ${targets.map((t) => `${t.year}-${String(t.month).padStart(2, '0')}`).join(', ')}`);
  const stat = (m) => `abiertos ${m.days.filter((d) => d.open).length}/${m.days.filter((d) => d.open || d.full).length} con servicio`;

  let cycle = 0;
  let found = false;
  do {
    cycle++;
    try {
      await gotoCalendar(page);
      let stockDom = await ensureStock(page);
      const parts = [];
      const hits = [];
      for (const t of targets) {
        const reached = await goToMonth(page, t.year, t.month);
        if (!reached) { parts.push(`${t.year}-${String(t.month).padStart(2, '0')}: no navegable`); continue; }
        stockDom = await ensureStock(page);
        const m = await readMonth(page);
        hits.push(...openInRange(m));
        parts.push(`${m.header} (${stat(m)})`);
      }
      log(`ciclo ${cycle} [solicitantes en el sitio: ${stockDom}]: ${parts.join(' | ')} | en tu rango: ${hits.length}`);

      if (hits.length) { await handleOpen(page, hits[0]); found = true; break; }

      // Rest on the first target month and show a status banner you can trust.
      await goToMonth(page, targets[0].year, targets[0].month).catch(() => {});
      await showBanner(page, hits.length);
    } catch (e) {
      log('error en ciclo (continuo):', e.message);
      await page.screenshot({ path: `${SHOTS}error-cycle-${cycle}.png`, fullPage: true }).catch(() => {});
    }
    if (once) break;
    const wait = CONFIG.pollIntervalMs + Math.floor((Math.random() * 2 - 1) * CONFIG.pollJitterMs);
    await sleep(Math.max(20_000, wait));
  } while (!found);

  if (found) {
    log('Cupo encontrado. Dejo el navegador ABIERTO. Cierra este proceso con Ctrl+C al terminar.');
    await new Promise(() => {}); // keep alive so the open window stays usable
  } else {
    await browser.close();
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
