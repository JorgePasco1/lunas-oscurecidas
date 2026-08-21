import "dotenv/config";
import type { Account } from "./types.js";

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

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

/** Parse ACCOUNT_1_*, ACCOUNT_2_*, … Falls back to the legacy single-account
 *  PNP_* vars so existing deployments keep working. */
function parseAccounts(): Account[] {
  const accounts: Account[] = [];
  for (let i = 1; i <= 20; i++) {
    const dni = process.env[`ACCOUNT_${i}_DNI`]?.trim();
    if (!dni) continue;
    const clave = process.env[`ACCOUNT_${i}_CLAVE`]?.trim();
    if (!clave) throw new Error(`ACCOUNT_${i}_DNI set but ACCOUNT_${i}_CLAVE missing`);
    accounts.push({
      label: optional(`ACCOUNT_${i}_LABEL`, `cuenta-${i}`),
      tipoDoc: optional(`ACCOUNT_${i}_TIPO_DOC`, "DNI"),
      documento: dni,
      clave,
      expediente: optional(`ACCOUNT_${i}_EXPEDIENTE`, ""),
    });
  }
  if (accounts.length === 0) {
    // Legacy single-account fallback.
    accounts.push({
      label: optional("PNP_LABEL", "cuenta-1"),
      tipoDoc: optional("PNP_TIPO_DOC", "DNI"),
      documento: required("PNP_DNI"),
      clave: required("PNP_CLAVE"),
      expediente: optional("EXPEDIENTE", ""),
    });
  }
  return accounts;
}

export const config = {
  site: {
    menuUrl:
      "https://sistemas.policia.gob.pe/lunasoscurecidas/Solicitud_Menu.aspx",
  },
  accounts: parseAccounts(),
  targetSede: optional("TARGET_SEDE", "LIMA-LA VICTORIA"),
  booking: {
    // Master switch. When false the watcher only notifies (never books).
    enabled: bool("BOOKING_ENABLED", false),
    // When true, do everything EXCEPT the final confirm — report "would book".
    dryRun: bool("DRY_RUN_BOOKING", true),
    // Prefer the earliest slot that fits ALL unbooked accounts together.
    sameSlot: bool("BOOK_SAME_SLOT", true),
    // How many account browser sessions to run at once (Pi RAM is limited).
    concurrency: optionalInt("BOOK_CONCURRENCY", 1),
  },
  telegram: {
    // Optional at import so the scraper can run standalone for selector
    // discovery; index.ts calls assertTelegramConfigured() before scheduling.
    token: optional("TELEGRAM_BOT_TOKEN", ""),
    chatId: optional("TELEGRAM_CHAT_ID", ""),
  },
  schedule: {
    checkCron: optional("CHECK_CRON", "*/2 * * * *"),
    heartbeatHours: optionalInt("HEARTBEAT_HOURS", 6),
    failureAlertThreshold: optionalInt("FAILURE_ALERT_THRESHOLD", 3),
  },
  dataDir: optional("DATA_DIR", "./data"),
  headless: optional("HEADLESS", "true").toLowerCase() !== "false",
  // Use a system-installed Chromium (e.g. /usr/bin/chromium on Raspberry Pi OS)
  // instead of Playwright's downloaded build. Avoids the ~150MB SD write and the
  // Debian-trixie dep mismatch. Empty = Playwright's bundled Chromium.
  chromiumPath: optional("CHROMIUM_PATH", ""),
  // On an old microSD we want to minimize writes. Failure screenshots are only
  // written for non-network failures (a blank page from a refused connection is
  // useless), and overwrite a single file per stage. Set false to disable fully.
  saveScreenshots: optional("SAVE_SCREENSHOTS", "true").toLowerCase() !== "false",
  // Optional dead-man's-switch ping URL (e.g. healthchecks.io). Pinged once per
  // cycle so an external monitor alerts you if the Pi/internet goes down.
  healthcheckUrl: optional("HEALTHCHECK_URL", ""),
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
