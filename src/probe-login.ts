/**
 * Read-only recon of the login page. Needs NO credentials.
 * Dumps the form structure so we can confirm the login-stage selectors.
 *   npx tsx src/probe-login.ts
 */
import { chromium } from "playwright";

const URL =
  "https://sistemas.policia.gob.pe/lunasoscurecidas/Solicitud_Menu.aspx";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1500);

  const selects = await page.locator("select").count();
  console.log(`\n<select> count: ${selects}`);
  for (let i = 0; i < selects; i++) {
    const opts = await page.locator("select").nth(i).locator("option").allInnerTexts();
    const id = await page.locator("select").nth(i).getAttribute("id");
    console.log(`  select[${i}] id=${id}  options=[${opts.map((o) => o.trim()).join(" | ")}]`);
  }

  const inputs = await page.locator("input").count();
  console.log(`\n<input> count: ${inputs}`);
  for (let i = 0; i < inputs; i++) {
    const el = page.locator("input").nth(i);
    const [type, ph, id, name] = await Promise.all([
      el.getAttribute("type"),
      el.getAttribute("placeholder"),
      el.getAttribute("id"),
      el.getAttribute("name"),
    ]);
    console.log(`  input[${i}] type=${type} placeholder=${JSON.stringify(ph)} id=${id} name=${name}`);
  }

  const buttons = await page.getByRole("button").allInnerTexts().catch(() => []);
  console.log(`\nbuttons: ${JSON.stringify(buttons)}`);
  const links = await page.getByRole("link").allInnerTexts().catch(() => []);
  console.log(`links (first 15): ${JSON.stringify(links.slice(0, 15))}`);

  const title = await page.title();
  console.log(`\npage title: ${title}`);
} catch (err) {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
