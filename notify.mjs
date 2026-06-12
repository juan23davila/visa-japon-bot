// Alert channels: WhatsApp (CallMeBot) + local macOS sound/notification.
import { execFile } from 'node:child_process';

const log = (...a) => console.log(new Date().toLocaleString('es-CO'), ...a);

async function sendWhatsApp(wa, text) {
  if (!wa.phone || !wa.apikey) {
    log('[wa] WhatsApp no configurado (falta WHATSAPP_PHONE o CALLMEBOT_APIKEY). Omito el envio.');
    return false;
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(wa.phone)}`
            + `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(wa.apikey)}`;
  try {
    const res = await fetch(url);
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 140);
    log('[wa] respuesta:', res.status, body);
    return res.ok;
  } catch (e) {
    log('[wa] error de red:', e.message);
    return false;
  }
}

// Phone call with text-to-speech via CallMeBot (paid service, separate authorization).
async function makeCall(wa, text) {
  if (!wa.call) { log('[call] llamada desactivada (CALL_ENABLED=false). Omito.'); return false; }
  if (!wa.phone || !wa.callApikey) { log('[call] llamada no configurada (falta phone o apikey).'); return false; }
  const phone = wa.phone.startsWith('+') ? wa.phone : `+${wa.phone}`;
  const url = `https://api.callmebot.com/call.php?phone=${encodeURIComponent(phone)}`
            + `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(wa.callApikey)}&lang=es-ES`;
  try {
    const res = await fetch(url);
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
    log('[call] respuesta:', res.status, body);
    return res.ok;
  } catch (e) {
    log('[call] error de red:', e.message);
    return false;
  }
}

function macNotify(title, message) {
  execFile('osascript', ['-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Sosumi"`,
  ], () => {});
}

function macSound(times = 8) {
  let n = 0;
  const beep = () => {
    if (n++ >= times) return;
    execFile('afplay', ['/System/Library/Sounds/Sosumi.aiff'], () => setTimeout(beep, 650));
  };
  beep();
  // Spoken alert in Spanish (ignored if the voice is not installed).
  execFile('say', ['-v', 'Paulina', 'Cupo de visa disponible. Corre al computador.'], () => {});
}

export async function alertOpen(CONFIG, { dateLabel, timeLabel, note = '', applicants }) {
  const msg = `🟢 CUPO DE VISA DISPONIBLE\n`
    + `Fecha: ${dateLabel}${timeLabel ? `\nHoras: ${timeLabel}` : ''}\n`
    + `Cupo para: ${applicants ?? CONFIG.applicantsLabel} solicitante(s)\n`
    + (note ? `⚠️ ${note}\n` : '')
    + `El navegador quedo abierto en la pagina. Entra y CONFIRMA ya, el cupo puede irse en segundos.`;
  if (CONFIG.sound) macSound();
  macNotify('🟢 Cupo de visa disponible', `${dateLabel} ${timeLabel || ''}`.trim());
  const waOk = await sendWhatsApp(CONFIG.whatsapp, msg);
  const callText = 'Atencion. Hay un cupo de visa de Japon disponible. '
    + 'Entra al computador y confirma la cita ahora. Repito, cupo de visa disponible.';
  const callOk = await makeCall(CONFIG.whatsapp, callText);
  return { waOk, callOk };
}

export async function testAlert(CONFIG) {
  log('Disparando alerta de PRUEBA (sonido + notificacion + WhatsApp + llamada)...');
  if (CONFIG.sound) macSound(2);
  macNotify('Prueba del bot de visa', 'Si ves esto, las alertas locales funcionan.');
  const waOk = await sendWhatsApp(CONFIG.whatsapp,
    '✅ Prueba del bot de cita de visa (Embajada de Japon). Si lees esto, el mensaje de WhatsApp funciona.');
  const callOk = await makeCall(CONFIG.whatsapp,
    'Esta es una llamada de prueba del bot de cita de visa de Japon. Si escuchas este mensaje, las llamadas funcionan correctamente.');
  log(`Resultado prueba -> WhatsApp: ${waOk ? 'ENVIADO' : 'fallo'} | Llamada: ${callOk ? 'OK' : 'fallo'}`);
}
