# Lunas Oscurecidas — Watcher de Cupos

Un bot que revisa cada 5 minutos el sistema de la PNP
(`sistemas.policia.gob.pe/lunasoscurecidas`), abre la ventana **Reserva de Citas**
de tu expediente y avisa por **Telegram** apenas se abran cupos en la sede que vigilas
(por defecto **LIMA-LA VICTORIA**). No reserva por ti — solo te avisa para que entres
y reserves manualmente.

Incluye monitoreo de salud: mensaje de arranque, "latidos" periódicos de que sigue
vivo, y una alerta cuando el sitio está caído o el login falla (con aviso de
recuperación).

## Cómo funciona

Automatiza con un navegador headless (Playwright) el mismo flujo que haces a mano:

1. Login con DNI + clave.
2. Abre el expediente (ícono del ojo en *Acciones*).
3. Abre **Reservar Cita**.
4. Selecciona la sede y recorre cada fecha, leyendo si hay horas/cupos disponibles.
5. Si encuentra cupos nuevos → alerta por Telegram (sin spamear si el cupo persiste).

El sitio es ASP.NET WebForms (postbacks con ViewState); por eso se usa un navegador
real en vez de replicar los requests HTTP, que serían mucho más frágiles.

## Requisitos

- Node.js 22+ (hay un `.nvmrc`; corre `nvm use`)
- pnpm 11 (via corepack: `corepack enable`)
- Una cuenta en [fly.io](https://fly.io) (para hosting 24/7)
- Un bot de Telegram

## 1. Crear el bot de Telegram

1. En Telegram, habla con [@BotFather](https://t.me/BotFather) → `/newbot` → sigue los
   pasos. Te da un **token** como `123456:ABC-...`.
2. Envíale **cualquier mensaje** a tu nuevo bot (para que pueda escribirte).
3. Abre en el navegador (reemplaza el token):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   y copia `result[0].message.chat.id` — ese es tu **TELEGRAM_CHAT_ID**.

## 2. Configurar

```bash
nvm use            # Node 22 (ver .nvmrc)
corepack enable    # habilita pnpm
cp .env.example .env
# edita .env con tu DNI, clave, token y chat id
pnpm install
```

## 3. Probar localmente

Descubrir/confirmar selectores con navegador visible (una sola pasada, sin Telegram):

```bash
HEADLESS=false pnpm check
```

Deberías ver el flujo completo y, al final, `no cupos available right now` (lo normal).
Las capturas de fallo quedan en `data/screenshots/`.

> **Confirmar selectores post-login.** Los selectores de la página de login ya
> están verificados contra el sitio real. Los pasos posteriores (ícono del ojo,
> botón *Reservar Cita*, dropdowns del modal) sólo pueden confirmarse con tu
> sesión. En tu primera corrida usa `DUMP_DOM` para imprimir la estructura exacta
> de esas partes:
>
> ```bash
> DUMP_DOM=true HEADLESS=false pnpm check
> ```
>
> Si algún paso falla, comparte esa salida (o la captura en `data/screenshots/`)
> para ajustar el selector en `src/scraper.ts`.

También hay utilidades: `pnpm probe` (inspecciona la página de login sin
credenciales) y `pnpm verify` (prueba offline de la lógica de alertas/dedup/fallos).

Correr el watcher completo (con scheduler + Telegram):

```bash
pnpm dev
```

## 4. Desplegar en fly.io

```bash
fly launch --no-deploy                 # crea la app (usa el fly.toml incluido)
fly volumes create data --size 1 --region scl
fly secrets set \
  PNP_DNI=70886597 \
  PNP_CLAVE='tu-clave' \
  TELEGRAM_BOT_TOKEN='123456:ABC-...' \
  TELEGRAM_CHAT_ID='123456789'
fly deploy
fly logs           # ver los ciclos cada 5 min
```

El resto de la configuración (sede, cron, heartbeat) está en `[env]` de `fly.toml`
y puede ajustarse ahí o con `fly secrets set`.

## Configuración (variables de entorno)

| Variable | Default | Descripción |
|---|---|---|
| `PNP_DNI` | — | Número de documento para el login |
| `PNP_CLAVE` | — | Clave del sistema PNP |
| `PNP_TIPO_DOC` | `DNI` | Tipo de documento |
| `EXPEDIENTE` | (vacío) | Nº de expediente a abrir si hay varios; vacío = el primero |
| `TARGET_SEDE` | `LIMA-LA VICTORIA` | Sede a vigilar (texto exacto del dropdown) |
| `TELEGRAM_BOT_TOKEN` | — | Token de @BotFather |
| `TELEGRAM_CHAT_ID` | — | Tu chat id |
| `CHECK_CRON` | `*/5 * * * *` | Frecuencia del chequeo |
| `HEARTBEAT_HOURS` | `6` | Cada cuántas horas manda "sigo vivo" |
| `FAILURE_ALERT_THRESHOLD` | `3` | Fallos seguidos antes de alertar "degradado" |
| `HEADLESS` | `true` | `false` para ver el navegador en local |
| `DATA_DIR` | `./data` | Carpeta de estado + capturas (volumen en fly) |

## Notas / riesgos

- **CAPTCHA:** el login actual no muestra captcha. Si apareciera bajo automatización,
  el bot lo reportará como "degradado" y habría que adaptarlo.
- **Selectores:** si la PNP cambia el HTML, algún paso podría fallar; el bot te avisa
  (degradado) y guarda una captura en `data/screenshots/` para arreglarlo rápido.
- **Solo avisa, no reserva** — así no hay riesgo de que consuma tu única reserva.
