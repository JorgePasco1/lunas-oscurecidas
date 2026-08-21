import { config } from "./config.js";

/**
 * Dead-man's-switch ping. Call once per completed cycle. If HEALTHCHECK_URL is
 * set (e.g. a free healthchecks.io check), a successful GET tells the external
 * monitor "the loop is alive and has internet". When the Pi loses power or the
 * internet drops, these pings stop and the external monitor alerts YOU — the one
 * failure mode our own Telegram messages can't cover (no internet = no Telegram).
 *
 * Never throws: a failed ping just means we couldn't reach the monitor, which is
 * itself the signal (missing ping) that the monitor is designed to catch.
 */
export async function pingHealthcheck(): Promise<void> {
  const url = config.healthcheckUrl;
  if (!url) return;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    await fetch(url, { signal: controller.signal }).finally(() =>
      clearTimeout(t)
    );
  } catch (err) {
    console.warn("[health] healthcheck ping failed:", String(err));
  }
}
