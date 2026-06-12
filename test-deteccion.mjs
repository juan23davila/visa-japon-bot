// Validates the availability detection by SIMULATING an open day (icon_circle) on the
// first FULL day found, then running the REAL readMonth() from bot.mjs. No reservation is made.
import { chromium } from 'playwright';
import { readMonth, readDaySlots } from './bot.mjs';
const CAL = 'https://embjpcol.rsvsys.jp/reservations/calendar';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const b = await chromium.launch({ headless: true });
const c = await b.newContext({ locale: 'es-CO', timezoneId: 'America/Bogota', userAgent: UA, viewport: { width: 1366, height: 900 } });
const p = await c.newPage();
await p.goto(CAL, { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForTimeout(1200);
await Promise.all([
  p.waitForResponse((r) => /reservations\/calendar/.test(r.url()) && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
  p.selectOption('#stock', '2'),
]);
await p.waitForTimeout(1500);

// BEFORE: with everything full, no day should be open.
const before = await readMonth(p);
console.log('ANTES (real): dias open =', JSON.stringify(before.days.filter((d) => d.open).map((d) => d.day)));

// SIMULATE: flip the FIRST full day to an available one (icon_circle). Days come and go
// from the embassy calendar, so never hardcode a specific day number here.
const target = await p.evaluate(() => {
  for (const cell of document.querySelectorAll('.sc_cal_month_itemlist')) {
    const img = cell.querySelector('.c_cal_time_cell img');
    if (img && (img.getAttribute('src') || '').includes('disabled')) {
      img.src = '/assets/images/user/icon_circle.svg';
      return +cell.querySelector('.sc_cal_date').innerText.trim();
    }
  }
  return null;
});
console.log('dia lleno elegido para simular cupo:', target);

const after = await readMonth(p);
const dTarget = after.days.find((d) => d.day === target);
const opens = after.days.filter((d) => d.open).map((d) => d.day);
const fulls = after.days.filter((d) => d.full).length;
console.log(`DESPUES de simular cupo en el ${target}:`);
console.log('  dia simulado =', JSON.stringify(dTarget));
console.log('  dias open =', JSON.stringify(opens), '| dias full =', fulls);
const pass1 = !!(target && dTarget && dTarget.open && !dTarget.full);
console.log(pass1 ? '\nPASS test 1: deteccion de dia con circulo en el mes' : '\nFAIL test 1: no detecta el dia disponible');

// --- Test 2: slot extraction on a simulated day view ---
// Mirrors the real DOM: grey rows are plain text "残 0件", a bookable row is a LINK to
// reservations/option. Only the link must count.
await p.setContent(`<table>
  <tr><th>09:15</th><td><p>残 0件／ Solicitud(es)</p></td></tr>
  <tr><th>09:30</th><td><a href="/reservations/option?event_id=9&event_plan_id=8&date=2026%2F06%2F19&time_from=09%3A30&time_to=09%3A45">残 2件／ Solicitud(es)</a></td></tr>
  <tr><th>09:45</th><td><p>残 0件／ Solicitud(es)</p></td></tr>
</table>`);
const slots = await readDaySlots(p);
console.log('\nfranjas extraidas del DOM simulado:', JSON.stringify(slots));
const pass2 = slots.length === 1 && slots[0].time === '09:30' && slots[0].remaining === 2;
console.log(pass2 ? 'PASS test 2: solo cuenta franjas reservables (link), ignora las grises' : 'FAIL test 2: extraccion de franjas incorrecta');

console.log(pass1 && pass2 ? '\nPASS total' : '\nFAIL total');
process.exitCode = pass1 && pass2 ? 0 : 1;
await b.close();
