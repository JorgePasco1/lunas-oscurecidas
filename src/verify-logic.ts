/**
 * Offline verification of the watcher state machine (no site, no real Telegram).
 * Drives runCycle() with a fake scraper and asserts the alert/dedup/failure
 * behaviour. Run: npx tsx src/verify-logic.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point state + telegram at a sandbox BEFORE importing modules that read config.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lunas-verify-"));
process.env.DATA_DIR = tmp;
process.env.PNP_DNI = "00000000";
process.env.PNP_CLAVE = "x";
process.env.TELEGRAM_BOT_TOKEN = "test";
process.env.TELEGRAM_CHAT_ID = "test";
process.env.FAILURE_ALERT_THRESHOLD = "2";
// This test exercises the alert/failure state machine only — never real booking.
// Force it off so a real .env with BOOKING_ENABLED=true can't launch browsers here.
process.env.BOOKING_ENABLED = "false";

const sent: string[] = [];
// Stub fetch so telegram.ts "sends" successfully offline, and capture the text.
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (typeof body.text === "string") sent.push(body.text);
  } catch {
    /* ignore */
  }
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const { runCycle } = await import("./watcher.js");
const { loadState } = await import("./state.js");

import type { ScrapeResult, SlotInfo } from "./types.js";

const ok = (available: SlotInfo[]): (() => Promise<ScrapeResult>) =>
  async () => ({ ok: true, available });
const fail = (): (() => Promise<ScrapeResult>) =>
  async () => ({ ok: false, stage: "login", reason: "boom" });

const slot = (fecha: string, hora: string): SlotInfo => ({
  sede: "LIMA-LA VICTORIA",
  fecha,
  hora,
  cupos: 3,
});

let failures = 0;
function expect(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ❌ ${msg}`);
    failures++;
  } else {
    console.log(`  ✅ ${msg}`);
  }
}
function lastSent(): string {
  return sent[sent.length - 1] ?? "";
}

console.log("\n1) No availability → no alert");
sent.length = 0;
await runCycle(ok([]));
expect(sent.length === 0, "no alert when empty");

console.log("\n2) New slot → one alert");
sent.length = 0;
await runCycle(ok([slot("18/08/2026", "09:00")]));
expect(sent.length === 1 && lastSent().includes("CUPOS"), "alert on new slot");

console.log("\n3) Same slot again → deduped (no second alert)");
sent.length = 0;
await runCycle(ok([slot("18/08/2026", "09:00")]));
expect(sent.length === 0, "no re-alert while slot persists");

console.log("\n4) Slot disappears → no alert, state cleared");
sent.length = 0;
await runCycle(ok([]));
expect(sent.length === 0, "no alert when slot gone");
expect((await loadState()).alertedKeys.length === 0, "alertedKeys cleared");

console.log("\n5) Slot reappears → alerts again");
sent.length = 0;
await runCycle(ok([slot("18/08/2026", "09:00")]));
expect(sent.length === 1, "re-alert after reappear");

console.log("\n6) Failures below threshold → silent");
sent.length = 0;
await runCycle(fail());
expect(sent.length === 0, "1st failure silent (threshold=2)");

console.log("\n7) Failure hits threshold → one degraded alert");
sent.length = 0;
await runCycle(fail());
expect(
  sent.length === 1 && lastSent().includes("degraded"),
  "degraded alert at threshold"
);

console.log("\n8) Still failing → no repeat degraded alert");
sent.length = 0;
await runCycle(fail());
expect(sent.length === 0, "no repeated degraded spam");

console.log("\n9) Recovery → recovered alert");
sent.length = 0;
await runCycle(ok([]));
expect(
  sent.length === 1 && lastSent().includes("recovered"),
  "recovered alert after outage"
);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "🎉 ALL PASSED" : `💥 ${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
