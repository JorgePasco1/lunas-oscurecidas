import { attemptBookings, fmtBookingResults } from "./booking.js";
import { config } from "./config.js";
import { runScrape } from "./scraper.js";
import { loadState, saveState } from "./state.js";
import { esc, sendTelegram } from "./telegram.js";
import { limaNow } from "./time.js";
import {
  slotKey,
  type ScrapeResult,
  type SlotInfo,
  type WatcherState,
} from "./types.js";

const MENU_URL = config.site.menuUrl;

// In-memory state for the life of the process. Loaded from disk once; we only
// write back on *material* change to spare the Pi's old microSD. Volatile fields
// (lastSuccessAt, cyclesOkSinceHeartbeat) live in memory and get persisted
// opportunistically whenever a material write happens.
let mem: WatcherState | null = null;
async function getMem(): Promise<WatcherState> {
  if (!mem) mem = await loadState();
  return mem;
}

/** Signature of the fields whose change justifies a disk write. */
export function materialSig(s: WatcherState): string {
  return JSON.stringify({
    a: [...s.alertedKeys].sort(),
    f: s.failureStreak,
    d: s.degradedNotified,
    h: s.lastHeartbeatAt,
    b: Object.keys(s.booked).sort(),
    x: s.bookingHalted,
  });
}

export async function persistIfMaterial(
  state: WatcherState,
  sigBefore: string
): Promise<void> {
  if (materialSig(state) !== sigBefore) await saveState(state);
}

export function fmtSlots(slots: SlotInfo[]): string {
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
    lines.push(`• <b>${esc(fecha)}</b> — ${esc(horas)}`);
  }
  return lines.join("\n");
}

/** Run exactly one watch cycle: scrape, then handle alerts/failures against
 *  persisted state. Returns the (possibly mutated) state after saving it.
 *  `scrape` is injectable for testing; defaults to the real Playwright scraper. */
export async function runCycle(
  scrape: () => Promise<ScrapeResult> = runScrape
): Promise<WatcherState> {
  const state = await getMem();
  const sigBefore = materialSig(state);
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
        `⚠️ <b>Watcher degraded</b>\n` +
          `The PNP site check has failed ${state.failureStreak} times in a row.\n` +
          `Last stage: <code>${esc(result.stage)}</code>\n` +
          `Reason: ${esc(result.reason)}\n\n` +
          `<i>Likely the site is down or login is failing. I'll tell you when it recovers.</i>`
      );
      state.degradedNotified = true;
    }
    await persistIfMaterial(state, sigBefore);
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
      `✅ <b>Watcher recovered</b> — the PNP site is reachable again and the check is running normally.`
    );
  }

  const available = result.available;
  const currentKeys = new Set(available.map(slotKey));

  // Alert only on NEW availability we haven't alerted for yet.
  const alreadyAlerted = new Set(state.alertedKeys);
  const fresh = available.filter((s) => !alreadyAlerted.has(slotKey(s)));

  if (fresh.length > 0) {
    await sendTelegram(
      `🚨 <b>¡CUPOS DISPONIBLES!</b> 🚨\n` +
        `Sede: <b>${esc(config.targetSede)}</b>\n` +
        `Detectado: <b>${esc(limaNow())}</b>\n\n` +
        `${fmtSlots(fresh)}\n\n` +
        `👉 Entra YA a reservar: ${MENU_URL}`,
      { attempts: 6 } // critical alert — try harder over the flaky link
    );
    console.log(`[watcher] [${limaNow()}] alerted ${fresh.length} new slot(s)`);
  }

  // ---- Auto-booking ----
  if (config.booking.enabled && available.length > 0 && !state.bookingHalted) {
    const unbooked = config.accounts.filter((a) => !state.booked[a.label]);
    // Live: retry every cycle until booked. Dry-run: only act on NEW slots so we
    // don't re-report "would book" every 2 minutes while a slot lingers.
    const shouldAct = config.booking.dryRun ? fresh.length > 0 : true;
    if (unbooked.length > 0 && shouldAct) {
      console.log(
        `[watcher] booking (${config.booking.dryRun ? "DRY-RUN" : "LIVE"}) for: ${unbooked
          .map((a) => a.label)
          .join(", ")}`
      );
      const results = await attemptBookings(unbooked, available, config.booking.dryRun);
      // Record real bookings so we stop trying for those accounts.
      for (const r of results) {
        if (r.ok && !r.dryRun && r.slot) {
          state.booked[r.account] = {
            fecha: r.slot.fecha,
            hora: r.slot.hora,
            at: new Date().toISOString(),
          };
        }
      }
      const header = config.booking.dryRun
        ? `🧪 <b>SIMULACRO de reserva</b> (dry-run)`
        : `📩 <b>Intento de reserva</b>`;
      await sendTelegram(`${header}\n${fmtBookingResults(results)}`, { attempts: 6 });

      // Identical-or-nothing guard: if a LIVE attempt booked some but not all,
      // halt — never place the rest at a different slot. Needs manual coordination.
      if (!config.booking.dryRun) {
        const succeeded = results.filter((r) => r.ok && !r.dryRun).length;
        if (succeeded > 0 && succeeded < unbooked.length) {
          state.bookingHalted = true;
          await sendTelegram(
            `⚠️ <b>RESERVA PARCIAL</b> — se reservó para ${succeeded}/${unbooked.length}. ` +
              `Detuve el auto-booking para no separarlos en horarios distintos. ` +
              `Coordina/cancela manualmente y avísame para reanudar.`,
            { attempts: 6 }
          );
        }
      }
    }
  }

  // Keep alertedKeys in sync with what's currently available so a slot that
  // disappears and reappears will alert again.
  state.alertedKeys = [...currentKeys];

  await persistIfMaterial(state, sigBefore);
  return state;
}

/** Send the periodic "still alive" heartbeat if enough time has elapsed. */
export async function maybeHeartbeat(force = false): Promise<void> {
  const state = await getMem();
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
    `${healthy ? "✅" : "⚠️"} <b>Watcher activo</b>\n` +
      `Vigilando: <b>${esc(config.targetSede)}</b>\n` +
      `Última verificación OK: ${esc(lastCheck)}\n` +
      `Ciclos OK desde el último reporte: ${state.cyclesOkSinceHeartbeat}\n` +
      `Fallos consecutivos ahora: ${state.failureStreak}`,
    { silent: true }
  );

  state.lastHeartbeatAt = new Date(now).toISOString();
  state.cyclesOkSinceHeartbeat = 0;
  await saveState(state);
}
