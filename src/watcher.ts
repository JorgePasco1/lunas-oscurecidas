import { config } from "./config.js";
import { runScrape } from "./scraper.js";
import { loadState, saveState } from "./state.js";
import { sendTelegram } from "./telegram.js";
import {
  slotKey,
  type ScrapeResult,
  type SlotInfo,
  type WatcherState,
} from "./types.js";

const MENU_URL = config.site.menuUrl;

function fmtSlots(slots: SlotInfo[]): string {
  // Group horas by fecha for a compact message.
  const byFecha = new Map<string, SlotInfo[]>();
  for (const s of slots) {
    const arr = byFecha.get(s.fecha) ?? [];
    arr.push(s);
    byFecha.set(s.fecha, arr);
  }
  const lines: string[] = [];
  for (const [fecha, arr] of byFecha) {
    const horas = arr.map((a) => a.hora).join(", ");
    lines.push(`• *${fecha}* — ${horas}`);
  }
  return lines.join("\n");
}

/** Run exactly one watch cycle: scrape, then handle alerts/failures against
 *  persisted state. Returns the (possibly mutated) state after saving it.
 *  `scrape` is injectable for testing; defaults to the real Playwright scraper. */
export async function runCycle(
  scrape: () => Promise<ScrapeResult> = runScrape
): Promise<WatcherState> {
  const state = await loadState();
  const result = await scrape();
  const now = new Date();

  if (!result.ok) {
    state.failureStreak += 1;
    console.warn(
      `[watcher] scrape failed (streak ${state.failureStreak}) at ${result.stage}: ${result.reason}`
    );
    if (
      state.failureStreak >= config.schedule.failureAlertThreshold &&
      !state.degradedNotified
    ) {
      await sendTelegram(
        `⚠️ *Watcher degraded*\n` +
          `The PNP site check has failed ${state.failureStreak} times in a row.\n` +
          `Last stage: \`${result.stage}\`\n` +
          `Reason: ${result.reason}\n\n` +
          `_Likely the site is down or login is failing. I'll tell you when it recovers._`
      );
      state.degradedNotified = true;
    }
    await saveState(state);
    return state;
  }

  // Success path -------------------------------------------------------------
  const wasDegraded = state.degradedNotified;
  state.failureStreak = 0;
  state.degradedNotified = false;
  state.lastSuccessAt = now.toISOString();
  state.cyclesOkSinceHeartbeat += 1;

  if (wasDegraded) {
    await sendTelegram(
      `✅ *Watcher recovered* — the PNP site is reachable again and the check is running normally.`
    );
  }

  const available = result.available;
  const currentKeys = new Set(available.map(slotKey));

  // Alert only on NEW availability we haven't alerted for yet.
  const alreadyAlerted = new Set(state.alertedKeys);
  const fresh = available.filter((s) => !alreadyAlerted.has(slotKey(s)));

  if (fresh.length > 0) {
    await sendTelegram(
      `🚨 *¡CUPOS DISPONIBLES!* 🚨\n` +
        `Sede: *${config.targetSede}*\n\n` +
        `${fmtSlots(fresh)}\n\n` +
        `👉 Entra YA a reservar: ${MENU_URL}`
    );
    console.log(`[watcher] alerted ${fresh.length} new slot(s)`);
  }

  // Keep alertedKeys in sync with what's currently available so a slot that
  // disappears and reappears will alert again.
  state.alertedKeys = [...currentKeys];

  await saveState(state);
  return state;
}

/** Send the periodic "still alive" heartbeat if enough time has elapsed. */
export async function maybeHeartbeat(force = false): Promise<void> {
  const state = await loadState();
  const now = Date.now();
  const intervalMs = config.schedule.heartbeatHours * 3600_000;
  const last = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : 0;

  if (!force && now - last < intervalMs) return;

  const lastCheck = state.lastSuccessAt
    ? new Date(state.lastSuccessAt).toLocaleString("es-PE", {
        timeZone: "America/Lima",
      })
    : "—";
  const healthy = state.failureStreak === 0;
  await sendTelegram(
    `${healthy ? "✅" : "⚠️"} *Watcher activo*\n` +
      `Vigilando: *${config.targetSede}*\n` +
      `Última verificación OK: ${lastCheck}\n` +
      `Ciclos OK desde el último reporte: ${state.cyclesOkSinceHeartbeat}\n` +
      `Fallos consecutivos ahora: ${state.failureStreak}`,
    { silent: true }
  );

  state.lastHeartbeatAt = new Date(now).toISOString();
  state.cyclesOkSinceHeartbeat = 0;
  await saveState(state);
}
