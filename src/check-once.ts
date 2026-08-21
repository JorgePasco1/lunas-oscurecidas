/**
 * One-shot scrape for local selector discovery and debugging.
 *   HEADLESS=false npm run check
 * Prints the structured result and (on failure) the screenshot path. Does NOT
 * send Telegram messages or touch the persisted alert state.
 */
import { runScrape } from "./scraper.js";
import { limaNow } from "./time.js";

const result = await runScrape();
const at = limaNow();

if (result.ok) {
  if (result.available.length === 0) {
    console.log(`\n✅ [${at}] Scrape OK — no cupos available right now (expected baseline).`);
  } else {
    console.log(`\n🚨 [${at}] Scrape OK — ${result.available.length} slot(s) available:`);
    for (const s of result.available) {
      console.log(`  ${s.sede} | ${s.fecha} | ${s.hora} | cupos≈${s.cupos}`);
    }
  }
} else {
  console.log(`\n❌ Scrape FAILED at "${result.stage}": ${result.reason}`);
  if (result.screenshot) console.log(`   screenshot: ${result.screenshot}`);
  process.exitCode = 1;
}
