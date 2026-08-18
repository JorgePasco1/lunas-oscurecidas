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
import type { ScrapeResult, SlotInfo } from "./types.js";

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

async function screenshot(page: Page, name: string): Promise<string> {
  const dir = path.join(config.dataDir, "screenshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
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

async function login(page: Page): Promise<void> {
  log("navigating to menu");
  await page.goto(config.site.menuUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });

  // Concrete ASP.NET control ids, confirmed against the live login DOM.
  // (Regex placeholders are ambiguous here — the page hides several other
  //  "clave" / "nro de documento" inputs for the password-recovery flow.)
  const tipoDoc = page.locator("#DdlDocumento");
  await tipoDoc.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await tipoDoc.selectOption({ label: config.pnp.tipoDoc }).catch(async () => {
    const labels = await optionLabels(tipoDoc);
    const match = labels.find((l) =>
      l.toUpperCase().includes(config.pnp.tipoDoc.toUpperCase())
    );
    if (match) await tipoDoc.selectOption({ label: match });
  });
  await settle(page, 500);

  await page.locator("#TxtCIP").fill(config.pnp.documento);
  await page.locator("#TxtClave").fill(config.pnp.clave);

  await page.locator("#BtnContinuar").click({ timeout: STEP_TIMEOUT });

  // Success = the solicitudes listing shows up (table / "Nuevo Trámite" button).
  await page
    .getByText(/Listado de Solicitudes|Nuevo Trámite|Total de registros/i)
    .first()
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT });
  log("logged in");
}

async function openExpediente(page: Page): Promise<void> {
  // Pick the target row (by expediente number if configured, else the first).
  let row: Locator;
  if (config.pnp.expediente) {
    row = page.locator("tr", { hasText: config.pnp.expediente }).first();
  } else {
    // First data row of the solicitudes table.
    row = page.locator("table tbody tr").first();
  }
  await row.waitFor({ state: "visible", timeout: STEP_TIMEOUT });

  await dump("solicitudes table row", async () => {
    console.log("row HTML:", await row.innerHTML());
  });

  // The "Acciones" cell holds an eye icon (link or button). Click the last
  // interactive element in the row.
  const action = row.locator("a, button").last();
  await action.click({ timeout: STEP_TIMEOUT });

  await page
    .getByText(/Detalle Seguimiento de Trámite|Etapas del Trámite/i)
    .first()
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT });
  log("opened expediente detail");
}

async function openModal(page: Page): Promise<Locator> {
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

  // Exact name avoids matching the "Reserva Cita Peritaje" heading.
  await clickByText(page, /^Reservar Cita$/i);

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

async function readAvailability(
  page: Page,
  modal: Locator
): Promise<SlotInfo[]> {
  const { sede, fecha, hora } = await modalSelects(modal);

  // Select the target sede.
  const sedeLabels = await optionLabels(sede);
  log("sede options:", sedeLabels.join(" | "));
  const sedeMatch =
    sedeLabels.find(
      (l) => l.toUpperCase() === config.targetSede.toUpperCase()
    ) ??
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

  // Iterate every available fecha and inspect its horas.
  const fechaLabels = await optionLabels(fecha);
  const realFechas = fechaLabels.filter((f) => !NO_SLOT_RE.test(f));
  log("fecha options:", realFechas.join(" | ") || "(none)");

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
  return found;
}

export async function runScrape(): Promise<ScrapeResult> {
  // Small random jitter so we don't hit the server on an exact fixed cadence.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4000)));

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let stage = "launch";
  let page: Page | undefined;
  try {
    browser = await chromium.launch({
      headless: config.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale: "es-PE",
    });
    context.setDefaultTimeout(STEP_TIMEOUT);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page = await context.newPage();

    stage = "login";
    await login(page);

    stage = "open-expediente";
    await openExpediente(page);

    stage = "open-modal";
    const modal = await openModal(page);

    stage = "read-availability";
    const available = await readAvailability(page, modal);

    return { ok: true, available };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`FAILED at stage "${stage}": ${reason}`);
    let shot: string | undefined;
    if (page) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      shot = await screenshot(page, `fail-${stage}-${stamp}`);
      log("screenshot:", shot);
    }
    return { ok: false, stage, reason, screenshot: shot };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
