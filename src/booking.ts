import type { Page } from "playwright";
import { config } from "./config.js";
import {
  openSession,
  screenshot,
  selectSede,
  selectSlot,
  settleExport as settle,
  sortSlots,
  type Session,
} from "./scraper.js";
import { limaNow } from "./time.js";
import type { Account, BookingResult, SlotInfo } from "./types.js";

function log(...a: unknown[]): void {
  console.log("[booking]", ...a);
}

// Confirmed control ids from the live modal DOM dump. The booking sequence is:
//   Reservar Cita (btgSiguiente) -> Aceptar y confirmar (btnValidaAcepta) -> Aceptar (close)
// btnValidaCancelar is the SAFE abort used by the opt-in probe.
// NOTE: we NEVER touch #MainContent_BtnCancelar ("Cancelar Solicitud") — that
// would cancel the whole trámite.
const BTN_RESERVAR = "#MainContent_idUcitas_btgSiguiente";
const BTN_CONFIRMAR = "#MainContent_idUcitas_btnValidaAcepta";
const BTN_CANCELAR_RESERVA = "#MainContent_idUcitas_btnValidaCancelar";
const BTN_CERRAR_OK = "#MainContent_idUcitas_bntcerrarelim";
// "Validación de Seguridad" — an arithmetic captcha (class captcha-suma-txt)
// that must be solved into the Resultado field before clicking Reservar Cita.
const CAPTCHA_LABEL = "#MainContent_idUcitas_lblCaptchaOperacion";
const CAPTCHA_INPUT = "#MainContent_idUcitas_txtimg";

/** Read the captcha challenge (e.g. "53 + 31 = ?") and compute the answer.
 *  Supports +, -, × just in case, though the field is labelled "suma". */
async function solveCaptcha(
  page: Page
): Promise<{ challenge: string; answer: number } | null> {
  const raw = (await page.locator(CAPTCHA_LABEL).innerText().catch(() => "")) || "";
  const challenge = raw.trim();
  const m = challenge.match(/(-?\d+)\s*([+\-x*×])\s*(-?\d+)/i);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[3], 10);
  const op = m[2];
  const answer = op === "+" ? a + b : op === "-" ? a - b : a * b;
  return { challenge, answer };
}

/** Decide which slot each unbooked account should target.
 *  - sameSlot: everyone aims at the earliest slot that fits all of them
 *    (cupos >= n); if none fits, everyone aims at the earliest slot (they
 *    compete; losers retry next cycle).
 *  - otherwise: everyone aims at the earliest slot too (simplest). */
export function chooseTargets(
  slots: SlotInfo[],
  accounts: Account[]
): Map<string, SlotInfo> {
  const sorted = sortSlots(slots);
  const plan = new Map<string, SlotInfo>();
  if (sorted.length === 0) return plan;

  const n = accounts.length;
  const fitsAll = config.booking.sameSlot
    ? sorted.find((s) => s.cupos >= n)
    : undefined;
  const shared = fitsAll ?? sorted[0];
  for (const a of accounts) plan.set(a.label, shared);
  return plan;
}

/** Book (or dry-run) the given slot for one account. Opens its own session. */
export async function bookForAccount(
  account: Account,
  target: SlotInfo,
  dryRun: boolean
): Promise<BookingResult> {
  let session: Session | undefined;
  try {
    session = await openSession(account);
    const { page, modal } = session;
    const { fecha, hora, sedeMatch } = await selectSede(page, modal);

    const ok = await selectSlot(page, fecha, hora, target.fecha, target.hora);
    if (!ok) {
      return {
        account: account.label,
        ok: false,
        dryRun,
        reason: `slot ${target.fecha} ${target.hora} no longer selectable (vanished)`,
      };
    }
    const slot: SlotInfo = {
      sede: sedeMatch,
      fecha: target.fecha,
      hora: target.hora,
      cupos: target.cupos,
    };

    // Solve the arithmetic captcha and fill the Resultado field (required before
    // Reservar Cita). Harmless in dry-run (nothing is submitted).
    const cap = await solveCaptcha(page);
    if (cap) {
      await page.locator(CAPTCHA_INPUT).fill(String(cap.answer)).catch(() => {});
      log(`captcha "${cap.challenge}" -> ${cap.answer}`);
    } else {
      log("captcha not found/parsed");
    }
    const capNote = cap
      ? `captcha ${cap.challenge.replace(/\s*=.*/, "")} = ${cap.answer}`
      : "captcha NOT parsed";

    if (dryRun) {
      const shot = config.saveScreenshots
        ? await screenshot(page, `dryrun-${account.label}`).catch(() => undefined)
        : undefined;
      // Opt-in probe: reveal the confirm screen without committing, then abort.
      if ((process.env.DRY_RUN_PROBE ?? "").toLowerCase() === "true") {
        await probeConfirmScreen(session, account);
      }
      log(`DRY RUN — would book ${account.label}: ${target.fecha} ${target.hora} (${capNote})`);
      return {
        account: account.label,
        ok: true,
        dryRun: true,
        slot,
        screenshot: shot,
        note: capNote,
      };
    }

    // ---- LIVE booking (only when DRY_RUN_BOOKING=false) ----
    if (!cap) {
      return {
        account: account.label,
        ok: false,
        dryRun: false,
        slot,
        reason: "could not read/solve captcha — aborted before booking",
      };
    }
    log(`LIVE booking ${account.label}: ${target.fecha} ${target.hora} (${capNote})`);
    await page.locator(BTN_RESERVAR).click({ timeout: 20_000 });
    await settle(page, 1200);
    // Confirm panel (PanelValidar) appears; wait for its accept button.
    await page.locator(BTN_CONFIRMAR).waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(BTN_CONFIRMAR).click({ timeout: 20_000 });
    await settle(page, 1500);

    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    const confirmed = /reserv|cita.*(program|confirm|registr)|éxito|exito/i.test(
      bodyText
    );
    let shot: string | undefined;
    if (config.saveScreenshots) {
      shot = await screenshot(page, `booked-${account.label}`).catch(
        () => undefined
      );
    }
    // Close the success dialog if present (never fatal).
    await page.locator(BTN_CERRAR_OK).click({ timeout: 8_000 }).catch(() => {});

    if (!confirmed) {
      return {
        account: account.label,
        ok: false,
        dryRun: false,
        slot,
        reason: "clicked confirm but couldn't verify success text — CHECK MANUALLY",
        screenshot: shot,
      };
    }
    return { account: account.label, ok: true, dryRun: false, slot, screenshot: shot };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const shot = (err as { screenshot?: string }).screenshot;
    log(`booking failed for ${account.label}: ${reason}`);
    return { account: account.label, ok: false, dryRun, reason, screenshot: shot };
  } finally {
    await session?.close();
  }
}

/** Opt-in only: click Reservar Cita to reveal the confirm screen, capture it,
 *  then click the safe Cancelar to abort. Teaches us the real confirm DOM. */
async function probeConfirmScreen(session: Session, account: Account): Promise<void> {
  const { page } = session;
  // Solve the captcha first, else Reservar Cita won't advance to the confirm panel.
  const cap = await solveCaptcha(page);
  if (cap) await page.locator(CAPTCHA_INPUT).fill(String(cap.answer)).catch(() => {});
  log(`PROBE — clicking Reservar Cita to reveal confirm screen (${account.label})`);
  await page.locator(BTN_RESERVAR).click({ timeout: 20_000 }).catch((e) => {
    log("probe: Reservar Cita click failed:", String(e));
  });
  await settle(page, 1500);
  const buttons = await page
    .locator("input[type=submit], input[type=button], button")
    .evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => ({ id: e.id, text: (e as HTMLInputElement).value || e.textContent?.trim() }))
    )
    .catch(() => []);
  log("PROBE visible buttons on confirm screen:", JSON.stringify(buttons));
  if (config.saveScreenshots) {
    await screenshot(page, `probe-confirm-${account.label}`).catch(() => {});
  }
  // Abort safely — do NOT confirm.
  await page.locator(BTN_CANCELAR_RESERVA).click({ timeout: 10_000 }).catch(() => {
    log("probe: Cancelar click failed (confirm screen may differ)");
  });
  await settle(page, 800);
}

/** Attempt to book for all given accounts against the available slots.
 *  Runs with limited concurrency (Pi RAM). Returns one result per account. */
export async function attemptBookings(
  accounts: Account[],
  slots: SlotInfo[],
  dryRun: boolean
): Promise<BookingResult[]> {
  const targets = chooseTargets(slots, accounts);
  const results: BookingResult[] = [];
  const conc = Math.max(1, config.booking.concurrency);

  const queue = [...accounts];
  async function worker(): Promise<void> {
    for (;;) {
      const account = queue.shift();
      if (!account) return;
      const target = targets.get(account.label);
      if (!target) {
        results.push({
          account: account.label,
          ok: false,
          dryRun,
          reason: "no target slot",
        });
        continue;
      }
      results.push(await bookForAccount(account, target, dryRun));
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return results;
}

/** Format booking results for a Telegram message. */
export function fmtBookingResults(results: BookingResult[]): string {
  const at = limaNow();
  const lines = results.map((r) => {
    const who = `<b>${r.account}</b>`;
    if (r.ok && r.dryRun)
      return `🧪 ${who}: SIMULACRO — reservaría ${r.slot?.fecha} ${r.slot?.hora}${
        r.note ? ` · ${r.note}` : ""
      }`;
    if (r.ok) return `✅ ${who}: RESERVADO ${r.slot?.fecha} ${r.slot?.hora}`;
    return `⚠️ ${who}: no reservado — ${r.reason}`;
  });
  return `${lines.join("\n")}\n<i>${at}</i>`;
}
