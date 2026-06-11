// Central configuration. Secrets come from env.
// Run with: node --env-file=.env bot.mjs   (or use the npm scripts)
export const CONFIG = {
  calendarUrl: 'https://embjpcol.rsvsys.jp/reservations/calendar',
  applicants: Number(process.env.APPLICANTS ?? 2),

  // Target window (inclusive), ISO yyyy-mm-dd: from today through the first week of July.
  targetFrom: process.env.TARGET_FROM ?? '2026-06-10',
  targetTo: process.env.TARGET_TO ?? '2026-07-07',

  // Respectful polling: base interval +/- jitter (ms). Lower = faster but higher ban risk.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
  pollJitterMs: Number(process.env.POLL_JITTER_MS ?? 20_000),

  // Keep a visible window so you can finish the reservation by hand when a slot is found.
  headless: (process.env.HEADLESS ?? 'false') === 'true',

  // Local audible alarm on the Mac (redundancy on top of WhatsApp).
  sound: (process.env.SOUND ?? 'true') === 'true',

  // WhatsApp message (free) + phone call (paid) via CallMeBot. See README for setup.
  whatsapp: {
    phone: process.env.WHATSAPP_PHONE ?? '', // country code + number, no '+', e.g. 573001112233
    apikey: process.env.CALLMEBOT_APIKEY ?? '',
    // Phone call: the same apikey usually works. Costs ~$1-3/month after a free trial.
    callApikey: process.env.CALLMEBOT_CALL_APIKEY || process.env.CALLMEBOT_APIKEY || '',
    call: (process.env.CALL_ENABLED ?? 'true') === 'true',
  },
};
