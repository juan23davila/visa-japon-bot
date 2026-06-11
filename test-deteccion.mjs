// Validates the availability detection by SIMULATING an open day (icon_circle) on day 12,
// then running the REAL readMonth() from bot.mjs. No reservation is made.
import { chromium } from 'playwright';
import { readMonth } from './bot.mjs';
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

// SIMULATE: turn day 12 into an available day (icon_circle).
await p.evaluate(() => {
  for (const cell of document.querySelectorAll('.sc_cal_month_itemlist')) {
    if (cell.querySelector('.sc_cal_date')?.innerText.trim() === '12') {
      const box = cell.querySelector('.c_cal_time_cell');
      if (box && box.querySelector('img')) box.querySelector('img').src = '/assets/images/user/icon_circle.svg';
      else if (box) box.innerHTML = '<img src="/assets/images/user/icon_circle.svg">';
    }
  }
});

const after = await readMonth(p);
const d12 = after.days.find((d) => d.day === 12);
const opens = after.days.filter((d) => d.open).map((d) => d.day);
const fulls = after.days.filter((d) => d.full).length;
console.log('DESPUES de simular cupo en el 12:');
console.log('  dia 12 =', JSON.stringify(d12));
console.log('  dias open =', JSON.stringify(opens), '| dias full =', fulls);
console.log(d12 && d12.open && !d12.full ? '\nPASS: el bot AHORA detecta el dia 12 disponible' : '\nFAIL: no lo detecta');
await b.close();
