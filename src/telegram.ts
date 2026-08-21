import { config } from "./config.js";

const API_BASE = `https://api.telegram.org/bot${config.telegram.token}`;

/** Escape text for Telegram HTML parse mode. Use for ANY dynamic value
 *  (site data, error messages) interpolated into a message. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Send a Telegram message. Never throws — notification failures are logged and
 * swallowed so a Telegram outage can't crash the watcher loop.
 *
 * Retries with backoff because the Pi's 2.4GHz link is flaky and a dropped
 * cupo alert is the worst failure mode. `attempts` defaults to 4 (~1+2+4s of
 * backoff); callers can pass more for critical alerts.
 */
export async function sendTelegram(
  text: string,
  opts: { silent?: boolean; attempts?: number } = {}
): Promise<boolean> {
  const attempts = opts.attempts ?? 4;
  for (let i = 1; i <= attempts; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(`${API_BASE}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          disable_notification: opts.silent ?? false,
        }),
      }).finally(() => clearTimeout(timer));
      if (res.ok) return true;
      const body = await res.text().catch(() => "");
      // 4xx (bad token/chat/markup) won't fix on retry — give up immediately.
      if (res.status >= 400 && res.status < 500) {
        console.error(`[telegram] sendMessage rejected: ${res.status} ${body}`);
        return false;
      }
      console.error(`[telegram] sendMessage ${res.status} (attempt ${i}/${attempts})`);
    } catch (err) {
      console.error(`[telegram] sendMessage error (attempt ${i}/${attempts}):`, String(err));
    }
    if (i < attempts) await sleep(1000 * 2 ** (i - 1));
  }
  return false;
}
