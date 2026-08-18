import cron from "node-cron";
import { assertTelegramConfigured, config } from "./config.js";
import { ensureDataDir } from "./state.js";
import { esc, sendTelegram } from "./telegram.js";
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
      `Te avisaré apenas se abran cupos.`
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
