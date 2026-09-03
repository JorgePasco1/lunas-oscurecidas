import cron from "node-cron";
import { assertTelegramConfigured, config } from "./config.js";
import { ensureDataDir } from "./state.js";
import { esc, sendTelegram } from "./telegram.js";
import { pingHealthcheck } from "./health.js";
import { runWarm } from "./warm.js";
import { maybeHeartbeat, runCycle } from "./watcher.js";

let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn("[index] previous cycle still running; skipping this tick");
    return;
  }
  running = true;
  try {
    await runCycle();
    await maybeHeartbeat();
    // Liveness ping AFTER the cycle completed: proves the loop ran and has
    // internet. If this stops (power/internet down), the external monitor alerts.
    await pingHealthcheck();
  } catch (err) {
    // runCycle handles its own errors; this is a last-resort guard.
    console.error("[index] unexpected error in tick:", err);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  assertTelegramConfigured();
  await ensureDataDir();

  const bookingMode = !config.booking.enabled
    ? "solo aviso (sin reservar)"
    : config.booking.dryRun
      ? "auto-reserva en SIMULACRO (dry-run)"
      : "auto-reserva EN VIVO";
  const who = config.accounts.map((a) => a.label).join(", ");

  // ---- Warm-session mode: one always-on browser per account, fast poll ----
  if (config.warm.enabled) {
    console.log(
      `[index] starting WARM mode — sede="${config.targetSede}" ` +
        `poll=${config.warm.pollSeconds}s accounts=${config.accounts.length} ` +
        `headless=${config.headless}`
    );
    const prefLine = config.booking.preferFecha
      ? `\nPrioridad: <b>${esc(config.booking.preferFecha)} ${esc(
          config.booking.preferHora
        )}</b>${
          config.booking.preferUntil
            ? ` hasta el <b>${esc(config.booking.preferUntil)}</b>, luego el más cercano`
            : " (estricto)"
        }`
      : "";
    await sendTelegram(
      `🟢 <b>Watcher iniciado</b> (sesiones tibias)\n` +
        `Vigilando <b>${esc(config.targetSede)}</b> cada <code>${esc(
          String(config.warm.pollSeconds)
        )}s</code> con sesiones ya logueadas.\n` +
        `Cuentas: <b>${esc(who)}</b>\n` +
        `Modo: <b>${esc(bookingMode)}</b>${prefLine}`
    );
    await runWarm(); // never returns
    return;
  }

  // ---- Legacy cron mode ----
  if (!cron.validate(config.schedule.checkCron)) {
    throw new Error(`Invalid CHECK_CRON: ${config.schedule.checkCron}`);
  }

  console.log(
    `[index] starting — sede="${config.targetSede}" cron="${config.schedule.checkCron}" ` +
      `heartbeat=${config.schedule.heartbeatHours}h headless=${config.headless}`
  );

  await sendTelegram(
    `🟢 <b>Watcher iniciado</b>\n` +
      `Vigilando <b>${esc(config.targetSede)}</b> cada <code>${esc(
        config.schedule.checkCron
      )}</code>.\n` +
      `Cuentas: <b>${esc(who)}</b>\n` +
      `Modo: <b>${esc(bookingMode)}</b>`
  );
  // Force a heartbeat now so the first "alive" baseline is recorded.
  await maybeHeartbeat(true);

  cron.schedule(config.schedule.checkCron, () => {
    void tick();
  });

  // Run one cycle immediately at boot instead of waiting for the first cron fire.
  void tick();

  // Keep the process alive.
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main().catch(async (err) => {
  console.error("[index] fatal:", err);
  await sendTelegram(
    `🔴 <b>Watcher se detuvo</b> con un error fatal:\n<code>${esc(
      err instanceof Error ? err.message : String(err)
    )}</code>`
  ).catch(() => {});
  process.exit(1);
});
