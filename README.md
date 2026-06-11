# Bot de cita de visa | Embajada de Japon en Colombia

Monitor que vigila el calendario de citas de visa de corta estancia
(`embjpcol.rsvsys.jp`) durante toda la noche. Cuando un dia se abre
(pasa de **× completo** a **○ disponible**) dentro de tu rango de fechas:

1. Trae el navegador al frente en la pagina de reserva.
2. Avanza al siguiente paso dejando **2 solicitantes** listos (best-effort).
3. Te dispara **WhatsApp** + **alarma sonora** en el Mac.
4. Se detiene para que tu **confirmes a mano** (no maneja tus datos de pasaporte).

Modo de operacion: **"avisar y dejar listo"**. El bot NO envia la reserva ni
escribe tus datos personales: te deja a un par de clics de confirmar.

## Hallazgos del sitio (verificados)

- No pide login para reservar.
- No hay captcha ni verificacion por codigo de email en el flujo.
- Existe el selector de "2 solicitantes" (`#stock`).
- Un dia disponible se detecta por el link `js_move_reserve_for_day` en su celda.
- A la fecha de construccion, **junio y julio estaban 100% llenos**: la via real
  es cazar cancelaciones o la apertura de fechas nuevas.

## Setup (una sola vez)

### 1. WhatsApp gratis con CallMeBot
1. Guarda en tus contactos el numero **+34 644 51 95 23** (CallMeBot).
2. Desde tu WhatsApp, mandale: `I allow callmebot to send me messages`
3. Te responde con tu **apikey** personal.
4. Edita `.env` y completa:
   - `WHATSAPP_PHONE=` tu numero con codigo de pais y sin `+` (ej. `573001112233`)
   - `CALLMEBOT_APIKEY=` la apikey que te dieron

### 1b. Llamada telefonica (recomendada para la noche)
Una llamada es mucho mas dificil de ignorar que un mensaje. La misma apikey suele
servir; CallMeBot da unas llamadas gratis de prueba y luego cuesta ~1 a 3 USD/mes.
Para activarla:
1. Guarda el contacto **+34 644 03 87 31** (CallMeBot llamadas).
2. Mandale por WhatsApp: `I allow callmebot to call me`
3. En `.env` deja `CALL_ENABLED=true` (ya viene asi). Para apagarla: `CALL_ENABLED=false`.

### 2. Probar que la alerta funciona
```bash
npm run test-alert
```
Debes oir la alarma del Mac, ver la notificacion, recibir el WhatsApp y (si la
activaste) una llamada que te lee la alerta en espanol.

## Correr toda la noche
```bash
npm start
```
- Usa `caffeinate` para que el Mac no se duerma mientras vigila.
- Abre una ventana de Chromium (dejala abierta, puedes minimizarla).
- Para detener: `Ctrl+C`.
- Cuando encuentra cupo crea `FOUND.lock` y se queda con el navegador abierto.
  Borra ese archivo para volver a activarlo: `rm FOUND.lock`.

### Prueba de un solo ciclo (sin quedarse corriendo)
```bash
npm run once
```

## Ajustes (`.env`)

| Variable | Que hace |
|---|---|
| `TARGET_FROM` / `TARGET_TO` | Rango de fechas objetivo (ISO `yyyy-mm-dd`). |
| `APPLICANTS` | Numero de solicitantes (2). |
| `POLL_INTERVAL_MS` | Intervalo base entre chequeos. Menor = mas rapido pero mas riesgo de bloqueo. |
| `POLL_JITTER_MS` | Variacion aleatoria del intervalo (parecer humano). |
| `HEADLESS` | `false` para ver la ventana (necesario para confirmar a mano). |
| `SOUND` | Alarma sonora local. |
| `CALL_ENABLED` | Llamada telefonica de alerta via CallMeBot (`true`/`false`). De pago tras la prueba gratis. |

## Aviso importante

Estos sistemas suelen prohibir el acceso automatizado en sus terminos. El bot usa
un intervalo respetuoso con jitter para minimizar el riesgo de bloqueo de IP, pero
el uso es bajo tu responsabilidad. El cupo puede esfumarse en segundos: responde
al WhatsApp de inmediato.
