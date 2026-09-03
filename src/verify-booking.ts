/**
 * Offline unit checks for the pure booking logic (no browser, no site).
 *   npx tsx src/verify-booking.ts
 */
process.env.PNP_DNI = "0";
process.env.PNP_CLAVE = "x";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.TELEGRAM_CHAT_ID = "t";
process.env.BOOK_SAME_SLOT = "true";
process.env.PREFER_UNTIL = "2026-09-06";

const { sortSlots, parseFecha } = await import("./scraper.js");
const { chooseTargets, fmtBookingResults } = await import("./booking.js");
const { sharedTarget, mergeSlots, acceptableSlots, pastFallbackDeadline } =
  await import("./warm.js");
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

console.log("\n6) fmtBookingResults is Telegram-HTML-safe in error reasons (400 regression)");
// The real bug on 2026-09-03: a Playwright error contained a literal <input.../>
// tag; sent with parse_mode=HTML, Telegram rejected the whole message (400) so
// the user never learned the booking failed. Two defenses: collapse to one line
// AND escape whatever HTML remains on it.
// 6a — HTML on the surviving first line must be ESCAPED, not passed through:
const escMsg = fmtBookingResults([
  { account: "Amigo", ok: false, dryRun: false, reason: 'hidden <input id="x"/> & gone' },
]);
expect(!/<input/i.test(escMsg), "no raw <input> tag survives in the message");
expect(escMsg.includes("&lt;input"), "the tag is HTML-escaped instead");
expect(escMsg.includes("&amp;"), "ampersands escaped too");
// 6b — a multi-line Playwright 'Call log' dump collapses to a single line:
const multiMsg = fmtBookingResults([
  {
    account: "Amigo",
    ok: false,
    dryRun: false,
    reason:
      "locator.waitFor: Timeout 15000ms\nCall log:\n  - waiting for <input .../> to be visible",
  },
]);
expect(!multiMsg.includes("\n  - waiting"), "multi-line Call log collapsed to one line");
expect(!/<input/i.test(multiMsg), "no raw <input> tag survives the collapse either");

console.log("\n7) warm mergeSlots dedups by fecha|hora keeping max cupos");
const merged = mergeSlots([
  [slot("01/10/2026", "08:00", 2), slot("01/10/2026", "09:00", 1)],
  [slot("01/10/2026", "08:00", 5), slot("30/09/2026", "10:00", 3)],
]);
expect(merged.length === 3, "three distinct slots after merge");
expect(merged[0].fecha === "30/09/2026", "earliest first");
expect(
  merged.find((s) => s.hora === "08:00")?.cupos === 5,
  "keeps the higher cupos count seen across sessions"
);

console.log("\n8) warm sharedTarget = identical-or-nothing across sessions");
// Both sessions see 01/10 08:00 with room for 2 → that's the shared target.
const jorgeSees = [slot("30/09/2026", "10:00", 2), slot("01/10/2026", "08:00", 2)];
const amigoSees = [slot("01/10/2026", "08:00", 2)];
const shared = sharedTarget([jorgeSees, amigoSees], 2);
expect(
  shared?.fecha === "01/10/2026" && shared?.hora === "08:00",
  "picks the slot BOTH sessions see with cupos>=2 (not Jorge's earlier solo slot)"
);
// Only one session sees the slot → book nobody.
const noneShared = sharedTarget(
  [[slot("01/10/2026", "08:00", 2)], [slot("02/10/2026", "09:00", 2)]],
  2
);
expect(noneShared === null, "no common slot → null (book none)");
// A common slot with only 1 cupo can't fit both → null.
const tooFew = sharedTarget(
  [[slot("01/10/2026", "08:00", 1)], [slot("01/10/2026", "08:00", 1)]],
  2
);
expect(tooFew === null, "common slot but only 1 cupo → null (can't seat both)");

console.log("\n9) slot preference: 'prefer 01/10 08:00, else same day 01/10 only'");
const prefs = { preferFecha: "01/10/2026", preferHora: "08:00" };
const pool = [
  slot("30/09/2026", "07:00", 5), // earlier date — must be IGNORED
  slot("01/10/2026", "10:00", 2), // same day, other hour
  slot("01/10/2026", "08:00", 1), // exact preferred hour
  slot("02/10/2026", "08:00", 9), // later date — ignored
];
const acc = acceptableSlots(pool, prefs);
expect(acc.length === 2, "only the two 01/10 slots are acceptable (other dates dropped)");
expect(
  acc[0].fecha === "01/10/2026" && acc[0].hora === "08:00",
  "preferred hour 08:00 ranked first"
);
expect(acc[1].hora === "10:00", "other same-day hour ranked after");
// Jorge alone (n=1): should target 01/10 08:00 even though 30/09 is earlier.
const jTarget = sharedTarget([pool], 1, prefs);
expect(
  jTarget?.fecha === "01/10/2026" && jTarget?.hora === "08:00",
  "single-account target = preferred 01/10 08:00 (not the earlier 30/09 slot)"
);
// If only other-date slots exist, book NOTHING (wait for 01/10).
const noPref = sharedTarget([[slot("30/09/2026", "07:00", 9)]], 1, prefs);
expect(noPref === null, "no 01/10 slot available → null (wait, don't book another day)");

console.log("\n10) fallback deadline: hold out for PREFER_FECHA, then widen (PREFER_UNTIL=2026-09-06)");
expect(pastFallbackDeadline("2026-09-03") === false, "before deadline → still strict");
expect(pastFallbackDeadline("2026-09-05") === false, "day before → still strict");
expect(pastFallbackDeadline("2026-09-06") === true, "on the deadline → widen");
expect(pastFallbackDeadline("2026-10-01") === true, "after deadline → widen");
// After widening, an empty pref books the earliest ANY date (30/09 beats 01/10):
const widened = sharedTarget(
  [[slot("30/09/2026", "07:00", 5), slot("01/10/2026", "08:00", 5)]],
  1,
  { preferFecha: "", preferHora: "" }
);
expect(
  widened?.fecha === "30/09/2026",
  "widened search books the earliest slot on any date"
);

console.log(`\n${fails === 0 ? "🎉 ALL PASSED" : `💥 ${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
