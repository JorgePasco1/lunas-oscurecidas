/**
 * One-shot: open the Reserva de Citas modal and print its full HTML, so we can
 * find the captcha ("Validación de Seguridad") field/button ids even without a
 * live cupo (the static markup is usually present, just populated on postback).
 *   pnpm exec tsx src/dump-modal.ts
 */
import { config } from "./config.js";
import { openSession } from "./scraper.js";

const s = await openSession(config.accounts[0]);
try {
  const html = await s.modal.innerHTML();
  console.log("=== MODAL HTML START ===");
  console.log(html);
  console.log("=== MODAL HTML END ===");
} finally {
  await s.close();
}
