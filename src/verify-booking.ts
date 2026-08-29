/**
 * Offline unit checks for the pure booking logic (no browser, no site).
 *   npx tsx src/verify-booking.ts
 */
process.env.PNP_DNI = "0";
process.env.PNP_CLAVE = "x";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.TELEGRAM_CHAT_ID = "t";
process.env.BOOK_SAME_SLOT = "true";

const { sortSlots, parseFecha } = await import("./scraper.js");
const { chooseTargets, fmtBookingResults } = await import("./booking.js");
import type { Account, SlotInfo } from "./types.js";

let fails = 0;
function expect(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) fails++;
}

const slot = (fecha: string, hora: string, cupos: number): SlotInfo => ({
  sede: "LIMA-LA VICTORIA",
  fecha,
  hora,
  cupos,
});
const acct = (label: string): Account => ({
  label,
  tipoDoc: "DNI",
  documento: "0",
  clave: "x",
  expediente: "",
});

console.log("\n1) parseFecha orders dates correctly");
expect(parseFecha("11/09/2026") < parseFecha("19/09/2026"), "Sep 11 < Sep 19");
expect(parseFecha("01/01/2027") > parseFecha("31/12/2026"), "next year later");

console.log("\n2) sortSlots is earliest-first, then hora");
const sorted = sortSlots([
  slot("19/09/2026", "09:00", 5),
  slot("11/09/2026", "11:00", 2),
  slot("11/09/2026", "08:00", 1),
]);
expect(
  sorted[0].fecha === "11/09/2026" && sorted[0].hora === "08:00",
  "earliest fecha+hora first"
);
expect(sorted[2].fecha === "19/09/2026", "later fecha last");

console.log("\n3) chooseTargets (sameSlot) picks earliest slot fitting ALL accounts");
const two = [acct("Jorge"), acct("Amigo")];
const t1 = chooseTargets(
  [slot("11/09/2026", "08:00", 1), slot("11/09/2026", "11:00", 3), slot("19/09/2026", "09:00", 9)],
  two
);
expect(t1.get("Jorge")?.hora === "11:00", "skips the 1-cupo slot, takes earliest with >=2");
expect(t1.get("Amigo")?.hora === "11:00", "both target the same slot");

console.log("\n4) chooseTargets books NOBODY when no slot fits all (identical-or-nothing)");
const t2 = chooseTargets([slot("11/09/2026", "08:00", 1)], two);
expect(t2.size === 0, "no slot has >=2 cupos → empty plan (book none)");

console.log("\n5) fmtBookingResults renders each state");
const msg = fmtBookingResults([
  { account: "Jorge", ok: true, dryRun: true, slot: slot("11/09/2026", "11:00", 3) },
  { account: "Amigo", ok: false, dryRun: true, reason: "vanished" },
]);
expect(msg.includes("SIMULACRO") && msg.includes("Jorge"), "dry-run line rendered");
expect(msg.includes("no reservado") && msg.includes("vanished"), "failure line rendered");

console.log(`\n${fails === 0 ? "🎉 ALL PASSED" : `💥 ${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
