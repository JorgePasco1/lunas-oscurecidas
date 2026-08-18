import "dotenv/config";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  site: {
    menuUrl:
      "https://sistemas.policia.gob.pe/lunasoscurecidas/Solicitud_Menu.aspx",
  },
  pnp: {
    tipoDoc: optional("PNP_TIPO_DOC", "DNI"),
    documento: required("PNP_DNI"),
    clave: required("PNP_CLAVE"),
    expediente: optional("EXPEDIENTE", ""),
  },
  targetSede: optional("TARGET_SEDE", "LIMA-LA VICTORIA"),
  telegram: {
    // Optional at import so the scraper can run standalone for selector
    // discovery; index.ts calls assertTelegramConfigured() before scheduling.
    token: optional("TELEGRAM_BOT_TOKEN", ""),
    chatId: optional("TELEGRAM_CHAT_ID", ""),
  },
  schedule: {
    checkCron: optional("CHECK_CRON", "*/5 * * * *"),
    heartbeatHours: optionalInt("HEARTBEAT_HOURS", 6),
    failureAlertThreshold: optionalInt("FAILURE_ALERT_THRESHOLD", 3),
  },
  dataDir: optional("DATA_DIR", "./data"),
  headless: optional("HEADLESS", "true").toLowerCase() !== "false",
};

export type Config = typeof config;

/** Fail fast at startup if Telegram isn't configured for the running watcher. */
export function assertTelegramConfigured(): void {
  if (!config.telegram.token || !config.telegram.chatId) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set to run the watcher."
    );
  }
}
