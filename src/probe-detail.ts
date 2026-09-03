/**
 * Throwaway diagnostic: log in as one account, open its expediente detail, and
 * report WHY the "Reservar Cita" (#MainContent_btnCita) button is/ isn't
 * clickable. Usage:  tsx src/probe-detail.ts [accountIndex=2]
 */
import { config } from "./config.js";
import { launchBrowser, login, openExpediente, screenshot } from "./scraper.js";

const idx = Number(process.argv[2] ?? "2") - 1;
const account = config.accounts[idx];
if (!account) {
  console.error(`No account at index ${idx + 1}`);
  process.exit(1);
}
console.log(`Probing account #${idx + 1}: ${account.label} (exp ${account.expediente})`);

const { page, close } = await launchBrowser();
try {
  await login(page, account);
  await openExpediente(page, account);

  const btn = page.locator("#MainContent_btnCita");
  console.log("btnCita count:", await btn.count());
  console.log("btnCita visible:", await btn.isVisible().catch(() => false));

  const info = await btn
    .evaluate((el) => {
      const chain: Array<Record<string, unknown>> = [];
      let cur: Element | null = el;
      while (cur) {
        const s = getComputedStyle(cur);
        chain.push({
          tag: cur.tagName,
          id: (cur as HTMLElement).id || null,
          cls: (cur as HTMLElement).className || null,
          display: s.display,
          visibility: s.visibility,
          hidden: (cur as HTMLElement).hasAttribute("hidden"),
        });
        cur = cur.parentElement;
      }
      const self = getComputedStyle(el);
      return {
        display: self.display,
        visibility: self.visibility,
        disabled: (el as HTMLInputElement).disabled,
        offsetParent: (el as HTMLElement).offsetParent
          ? ((el as HTMLElement).offsetParent as HTMLElement).id || "(unnamed)"
          : null,
        // The first ancestor that hides it:
        hiddenBy: chain.find(
          (c) => c.display === "none" || c.visibility === "hidden" || c.hidden
        ),
      };
    })
    .catch((e) => String(e));
  console.log("btnCita why-hidden:", JSON.stringify(info, null, 2));

  const text = await page
    .locator("#MainContent")
    .innerText()
    .catch(() => "");
  console.log("\n---- DETAIL PAGE TEXT (first 2500 chars) ----");
  console.log(text.slice(0, 2500));

  const shot = await screenshot(page, `probe-${account.label}-detail`).catch(
    () => undefined
  );
  console.log("\nscreenshot:", shot);
} catch (err) {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
} finally {
  await close();
}
