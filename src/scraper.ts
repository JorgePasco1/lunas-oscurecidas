import { promises as fs } from "node:fs";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { config } from "./config.js";
import type { Account, ScrapeResult, SlotInfo } from "./types.js";

const NAV_TIMEOUT = 45_000;
const STEP_TIMEOUT = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Texts that mean "no availability" in the Hora / Cupos widgets. */
const NO_SLOT_RE = /sin\s*cupos|seleccione|^\s*$/i;

function log(...args: unknown[]): void {
  console.log("[scraper]", ...args);
}

// Warm sessions poll every few seconds; silence the routine per-poll lines
// ("sede options", "fecha options: (none)") to keep the Pi's journal quiet.
// Real availability and errors are always logged.
let verboseScrape = true;
export function setScrapeVerbose(v: boolean): void {
  verboseScrape = v;
}

/** When DUMP_DOM=true, print structural details of a stage we couldn't probe
 *  unauthenticated (table rows, buttons, modal select ids) so a single live
 *  run reveals the exact selectors. No-op in production. */
const DUMP_DOM = (process.env.DUMP_DOM ?? "").toLowerCase() === "true";
async function dump(label: string, fn: () => Promise<void>): Promise<void> {
  if (!DUMP_DOM) return;
  try {
    console.log(`\n===== DOM DUMP: ${label} =====`);
    await fn();
    console.log(`===== end ${label} =====\n`);
  } catch (err) {
    console.log(`(dump "${label}" failed: ${String(err)})`);
  }
}

/** Wait for a WebForms postback to settle. UpdatePanel async postbacks are
 *  XHRs (no navigation), so we wait for network to go idle then add a small
 *  debounce; falls back gracefully on slow government infra. */
async function settle(page: Page, ms = 900): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: STEP_TIMEOUT })
    .catch(() => {});
  await page.waitForTimeout(ms);
}

/** Read the non-empty option labels of a <select>. */
async function optionLabels(select: Locator): Promise<string[]> {
  return select
    .locator("option")
    .allInnerTexts()
    .then((texts) => texts.map((t) => t.trim()).filter((t) => t.length > 0));
}

export async function settleExport(page: Page, ms?: number): Promise<void> {
  return settle(page, ms);
}

export async function screenshot(page: Page, name: string): Promise<string> {
  const dir = path.join(config.dataDir, "screenshots");
  await fs.mkdir(dir, { recursive: true });
  // Stable filename per stage (overwrites) so failures don't accumulate PNGs on
  // the SD card.
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  await enforceScreenshotCap(dir).catch(() => {});
  return file;
}

/** Keep the screenshots folder under config.screenshotMaxMB by deleting the
 *  oldest files first. The just-written file is newest, so it is never pruned. */
async function enforceScreenshotCap(dir: string): Promise<void> {
  const maxBytes = Math.max(1, config.screenshotMaxMB) * 1024 * 1024;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const files: { p: string; size: number; mtime: number }[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile()) files.push({ p, size: st.size, mtime: st.mtimeMs });
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total <= maxBytes) return;
  files.sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const f of files) {
    if (total <= maxBytes) break;
    await fs.unlink(f.p).catch(() => {});
    total -= f.size;
  }
}

/** True for connectivity failures (WiFi blip, site refusing the connection,
 *  DNS). A screenshot of these is a blank page — useless — and on a flaky link
 *  they'd be frequent, so we don't write them to the SD card. */
function isNetworkError(reason: string): boolean {
  return /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_INTERNET|ERR_ADDRESS|ERR_TIMED_OUT|ERR_SOCKET|net::|Timeout.*exceeded.*goto|NS_ERROR/i.test(
    reason
  );
}

/** Navigate with a couple of retries — the 2.4GHz link on the Pi is the flaky
 *  part, and a transient blip on the first request shouldn't fail the cycle. */
async function gotoWithRetry(page: Page, url: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      return;
    } catch (err) {
      lastErr = err;
      log(`goto attempt ${attempt} failed: ${String(err)}`);
      if (attempt < 3) await page.waitForTimeout(2000 * attempt);
    }
  }
  throw lastErr;
}

/** Click something addressed by visible text, trying button → link → any. */
async function clickByText(page: Page, name: string | RegExp): Promise<void> {
  const byButton = page.getByRole("button", { name, exact: false });
  if (await byButton.count()) {
    await byButton.first().click({ timeout: STEP_TIMEOUT });
    return;
  }
  const byLink = page.getByRole("link", { name, exact: false });
  if (await byLink.count()) {
    await byLink.first().click({ timeout: STEP_TIMEOUT });
    return;
  }
  await page.getByText(name).first().click({ timeout: STEP_TIMEOUT });
}

export async function login(page: Page, account: Account): Promise<void> {
  log(`navigating to menu (${account.label})`);
  await gotoWithRetry(page, config.site.menuUrl);

  // Concrete ASP.NET control ids, confirmed against the live login DOM.
  // (Regex placeholders are ambiguous here — the page hides several other
  //  "clave" / "nro de documento" inputs for the password-recovery flow.)
  const tipoDoc = page.locator("#DdlDocumento");
  await tipoDoc.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await tipoDoc.selectOption({ label: account.tipoDoc }).catch(async () => {
    const labels = await optionLabels(tipoDoc);
    const match = labels.find((l) =>
      l.toUpperCase().includes(account.tipoDoc.toUpperCase())
    );
    if (match) await tipoDoc.selectOption({ label: match });
  });
  await settle(page, 500);

  await page.locator("#TxtCIP").fill(account.documento);
  await page.locator("#TxtClave").fill(account.clave);

  await page.locator("#BtnContinuar").click({ timeout: STEP_TIMEOUT });

  // Success = the solicitudes listing shows up (table / "Nuevo Trámite" button).
  await page
    .getByText(/Listado de Solicitudes|Nuevo Trámite|Total de registros/i)
    .first()
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT });
  log("logged in");
}

export async function openExpediente(page: Page, account: Account): Promise<void> {
  // The "Acciones" eye icon is an <a id="...gvProgramacion_btnAccion_N">. These
  // links exist ONLY on real data rows, so they skip empty sub-tables like
  // "Programación de Expedientes / 0 registros" that break a naive first-row pick.
  let action: Locator;
  if (account.expediente) {
    // Pin to the row containing this expediente number, then its action link.
    const row = page.locator("tr", { hasText: account.expediente }).first();
    await row.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await dump("solicitudes table row", async () => {
      console.log("row HTML:", await row.innerHTML());
    });
    const inRow = row.locator("a[id*='btnAccion'], a, button");
    action = (await inRow.count()) ? inRow.last() : row.locator("a, button").last();
  } else {
    // No expediente pinned: take the first real action link on the page.
    action = page.locator("a[id*='btnAccion']").first();
    await action.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  }
  await action.click({ timeout: STEP_TIMEOUT });

  await page
    .getByText(/Detalle Seguimiento de Trámite|Etapas del Trámite/i)
    .first()
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT });
  log("opened expediente detail");
}

/** Read a booked ("Programado") Separa-Cita-Peritaje appointment from the detail
 *  page's Etapas table, if one exists. Returns its fecha/hora, or null if the
 *  cita step is still Pendiente (not booked). This is the GROUND TRUTH for
 *  whether an account already has its inspection appointment. */
export async function readProgrammedCita(
  page: Page
): Promise<{ fecha: string; hora: string } | null> {
  const row = page
    .locator("tr", { hasText: /Separa Cita Peritaje/i })
    .first();
  if (!(await row.count())) return null;
  const txt = (await row.innerText().catch(() => "")) || "";
  if (!/Programado/i.test(txt)) return null; // still Pendiente → not booked
  const m = txt.match(/(\d{2}\/\d{2}\/\d{4})\D{0,10}(\d{2}:\d{2})/);
  // Programmed even if we can't parse the exact time (be conservative: booked).
  return { fecha: m?.[1] ?? "?", hora: m?.[2] ?? "?" };
}

/** Error thrown when the reserve UI is unavailable because the account already
 *  has a programmed cita (the "Reservar Cita" section is hidden). Not a fault —
 *  it means this account is DONE. */
export interface AlreadyBookedError extends Error {
  alreadyBooked: { fecha: string; hora: string };
}

async function openModal(page: Page): Promise<Locator> {
  // Before trying to open the modal: if the reserve section (#MainContent_DivCita)
  // is hidden, this account has no reserve UI. The usual reason is that it ALREADY
  // has a programmed cita — in which case the site hides the button. Detect that
  // explicitly instead of timing out for 20s clicking an invisible button.
  const divCita = page.locator("#MainContent_DivCita");
  if ((await divCita.count()) && !(await divCita.isVisible().catch(() => false))) {
    const cita = await readProgrammedCita(page);
    if (cita) {
      const e = new Error(
        `already has a programmed cita ${cita.fecha} ${cita.hora}`
      ) as AlreadyBookedError;
      e.alreadyBooked = cita;
      throw e;
    }
    throw new Error("reserve section (DivCita) is hidden but no programmed cita found");
  }

  await dump("detail page buttons", async () => {
    const btns = await page.getByRole("button").allInnerTexts().catch(() => []);
    console.log("buttons:", JSON.stringify(btns));
    const submits = await page
      .locator('input[type=submit], input[type=button]')
      .evaluateAll((els) =>
        els.map((e) => ({ id: e.id, value: (e as HTMLInputElement).value }))
      )
      .catch(() => []);
    console.log("submit inputs:", JSON.stringify(submits));
  });

  // Confirmed control id. There are TWO "Reservar Cita" buttons on the page
  // (this one and one inside the modal), so target the id directly and fall
  // back to text only if the markup changes.
  const citaBtn = page.locator("#MainContent_btnCita");
  if (await citaBtn.count()) {
    await citaBtn.first().click({ timeout: STEP_TIMEOUT });
  } else {
    await clickByText(page, /^Reservar Cita$/i);
  }

  const modal = page
    .locator(".modal, [role=dialog]")
    .filter({ hasText: /Reserva de Citas/i })
    .first();

  // Fall back to any container that shows the Sede/Fecha/Hora labels.
  const target = (await modal.count())
    ? modal
    : page.locator("body").filter({ hasText: /Reserva de Citas/i }).first();

  await target
    .getByText(/Sede/i)
    .first()
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT });
  await settle(page, 800);

  await dump("modal selects", async () => {
    const info = await target
      .locator("select")
      .evaluateAll((els) =>
        els.map((e) => ({
          id: e.id,
          options: Array.from((e as HTMLSelectElement).options).map(
            (o) => o.text
          ),
        }))
      )
      .catch(() => []);
    console.log("selects:", JSON.stringify(info, null, 2));
  });

  log("opened reserva modal");
  return target;
}

/** Identify the Sede / Fecha / Hora selects inside the modal by DOM order,
 *  with a sanity check that select[0] really is the Sede list. */
async function modalSelects(
  modal: Locator
): Promise<{ sede: Locator; fecha: Locator; hora: Locator }> {
  // Confirmed control ids (preferred). Fall back to DOM order if the ids change.
  const byId = {
    sede: modal.locator("#MainContent_idUcitas_cbosede"),
    fecha: modal.locator("#MainContent_idUcitas_cboFecha"),
    hora: modal.locator("#MainContent_idUcitas_cboHora"),
  };
  if (
    (await byId.sede.count()) &&
    (await byId.fecha.count()) &&
    (await byId.hora.count())
  ) {
    return byId;
  }

  const selects = modal.locator("select");
  const count = await selects.count();
  if (count < 3) {
    throw new Error(`Expected >=3 selects in modal, found ${count}`);
  }
  return {
    sede: selects.nth(0),
    fecha: selects.nth(1),
    hora: selects.nth(2),
  };
}

/** Read whether the currently selected fecha exposes real Hora options. */
async function readHoraSlots(
  hora: Locator,
  modal: Locator,
  sede: string,
  fecha: string
): Promise<SlotInfo[]> {
  const horaLabels = await optionLabels(hora);
  const realHoras = horaLabels.filter((h) => !NO_SLOT_RE.test(h));
  if (realHoras.length === 0) return [];

  // Try to read a cupos count from the modal text (best-effort; the alert only
  // needs to say "there is availability").
  let cupos = 0;
  const modalText = (await modal.innerText().catch(() => "")) || "";
  const m = modalText.match(/cupos?\D{0,15}(\d+)/i);
  if (m) cupos = parseInt(m[1], 10);

  return realHoras.map((h) => ({
    sede,
    fecha,
    hora: h,
    cupos: cupos > 0 ? cupos : 1, // 1 = "at least one" when count is unknown
  }));
}

/** Select the target sede in the modal and wait for Fecha to repopulate.
 *  Returns the matched sede label. */
export async function selectSede(
  page: Page,
  modal: Locator
): Promise<{ sede: Locator; fecha: Locator; hora: Locator; sedeMatch: string }> {
  const { sede, fecha, hora } = await modalSelects(modal);
  const sedeLabels = await optionLabels(sede);
  if (verboseScrape) log("sede options:", sedeLabels.join(" | "));
  const sedeMatch =
    sedeLabels.find((l) => l.toUpperCase() === config.targetSede.toUpperCase()) ??
    sedeLabels.find((l) =>
      l.toUpperCase().includes(config.targetSede.toUpperCase())
    );
  if (!sedeMatch) {
    throw new Error(
      `Target sede "${config.targetSede}" not in options: ${sedeLabels.join(", ")}`
    );
  }
  await sede.selectOption({ label: sedeMatch });
  await settle(page);
  return { sede, fecha, hora, sedeMatch };
}

export async function readAvailability(
  page: Page,
  modal: Locator
): Promise<SlotInfo[]> {
  const { fecha, hora, sedeMatch } = await selectSede(page, modal);

  // TEST HOOK: inject a synthetic bookable slot into the real modal DOM so the
  // detection + alert pipeline can be exercised end-to-end while the live site
  // has no cupos. Enable with SIMULATE_CUPOS=true. Labels say SIMULADO so a
  // real alert is never mistaken for a genuine cupo.
  if ((process.env.SIMULATE_CUPOS ?? "").toLowerCase() === "true") {
    log("SIMULATE_CUPOS on — injecting fake slot into modal");
    await page.evaluate(() => {
      const f = document.querySelector<HTMLSelectElement>(
        "#MainContent_idUcitas_cboFecha"
      );
      if (f) {
        const o = document.createElement("option");
        o.text = "18/08/2026 (SIMULADO)";
        f.add(o);
      }
      const h = document.querySelector<HTMLSelectElement>(
        "#MainContent_idUcitas_cboHora"
      );
      if (h) {
        const o = document.createElement("option");
        o.text = "09:00 (SIMULADO)";
        h.add(o);
      }
    });
    // Read the injected hora directly (no fecha re-select, which would postback
    // and wipe the injected options).
    return readHoraSlots(hora, modal, sedeMatch, "18/08/2026 (SIMULADO)");
  }

  // Iterate every available fecha and inspect its horas.
  const fechaLabels = await optionLabels(fecha);
  const realFechas = fechaLabels.filter((f) => !NO_SLOT_RE.test(f));
  if (verboseScrape || realFechas.length > 0) {
    log("fecha options:", realFechas.join(" | ") || "(none)");
  }

  const found: SlotInfo[] = [];
  for (const f of realFechas) {
    await fecha.selectOption({ label: f }).catch(() => {});
    await settle(page);
    const slots = await readHoraSlots(hora, modal, sedeMatch, f);
    if (slots.length > 0) {
      log(`AVAILABILITY on ${f}:`, slots.map((s) => s.hora).join(", "));
      found.push(...slots);
    }
  }
  return sortSlots(found);
}

/** Parse a dd/mm/yyyy label to a sortable number (0 if unparseable). */
export function parseFecha(fecha: string): number {
  const m = fecha.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return 0;
  return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
}

/** Earliest fecha first, then earliest hora. */
export function sortSlots(slots: SlotInfo[]): SlotInfo[] {
  return [...slots].sort(
    (a, b) => parseFecha(a.fecha) - parseFecha(b.fecha) || a.hora.localeCompare(b.hora)
  );
}

/** Select a specific fecha then hora in the modal (for booking). Returns false
 *  if either option is no longer present (slot vanished between check and book). */
export async function selectSlot(
  page: Page,
  fecha: Locator,
  hora: Locator,
  targetFecha: string,
  targetHora: string
): Promise<boolean> {
  const fechas = await optionLabels(fecha);
  if (!fechas.includes(targetFecha)) return false;
  await fecha.selectOption({ label: targetFecha });
  await settle(page);
  const horas = await optionLabels(hora);
  if (!horas.includes(targetHora)) return false;
  await hora.selectOption({ label: targetHora });
  await settle(page, 600);
  return true;
}

export interface Session {
  browser: Browser;
  page: Page;
  modal: Locator;
  close: () => Promise<void>;
}

export interface BrowserHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/** Launch a fresh headless browser + page (no login yet). Reused by cold
 *  sessions and by warm sessions (which keep the browser and re-auth in place). */
export async function launchBrowser(): Promise<BrowserHandle> {
  const browser = await chromium.launch({
    headless: config.headless,
    executablePath: config.chromiumPath || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: "es-PE",
  });
  context.setDefaultTimeout(STEP_TIMEOUT);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  const page = await context.newPage();
  const close = async () => {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  };
  return { browser, context, page, close };
}

/** On an existing page, log in → open expediente → open the Reserva modal.
 *  Returns the modal Locator. Used both to establish and to RE-establish
 *  (re-auth) a warm session after a logout, reusing the same browser. Tags any
 *  error with the stage + a screenshot. */
export async function establishSession(
  page: Page,
  account: Account
): Promise<Locator> {
  let stage = "login";
  try {
    await login(page, account);
    stage = "open-expediente";
    await openExpediente(page, account);
    stage = "open-modal";
    return await openModal(page);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let shot: string | undefined;
    if (config.saveScreenshots && !isNetworkError(reason)) {
      shot = await screenshot(page, `fail-${stage}`).catch(() => undefined);
    }
    const e = err instanceof Error ? err : new Error(reason);
    (e as StageError).stage = stage;
    (e as StageError).screenshot = shot;
    throw e;
  }
}

/** True if `page` is sitting on the login screen (session expired / logged out):
 *  the Tipo-Documento select is present and the solicitudes listing is not. */
export async function isLoggedOut(page: Page): Promise<boolean> {
  const loginVisible = await page
    .locator("#DdlDocumento")
    .isVisible()
    .catch(() => false);
  return loginVisible;
}

/** Launch a browser, log in as `account`, open its expediente and the Reserva
 *  de Citas modal. Caller MUST call close(). */
export async function openSession(account: Account): Promise<Session> {
  const handle = await launchBrowser();
  const { browser, page, close } = handle;
  try {
    const modal = await establishSession(page, account);
    return { browser, page, modal, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Error thrown by openSession/booking, tagged with the stage + screenshot. */
interface StageError extends Error {
  stage?: string;
  screenshot?: string;
}

/** Ground-truth check after a booking attempt: reload the account's expediente
 *  detail and read whether a cita is now Programado. Reuses the logged-in page
 *  (the session cookie is still valid). Returns the booked cita, or null. */
export async function verifyBooked(
  page: Page,
  account: Account
): Promise<{ fecha: string; hora: string } | null> {
  await gotoWithRetry(page, config.site.menuUrl);
  await openExpediente(page, account);
  return readProgrammedCita(page);
}

/** Check availability for one account: open a session, read slots, close. */
export async function checkAvailability(account: Account): Promise<ScrapeResult> {
  // Small random jitter so we don't hit the server on an exact fixed cadence.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4000)));

  let session: Session | undefined;
  let stage = "read-availability";
  try {
    session = await openSession(account);
    const available = await readAvailability(session.page, session.modal);
    return { ok: true, available };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const se = err as StageError;
    log(`FAILED at stage "${se.stage ?? stage}": ${reason}`);
    return {
      ok: false,
      stage: se.stage ?? stage,
      reason,
      screenshot: se.screenshot,
    };
  } finally {
    await session?.close();
  }
}

/** Back-compat wrapper used by check-once and the watcher's default. */
export async function runScrape(): Promise<ScrapeResult> {
  return checkAvailability(config.accounts[0]);
}
