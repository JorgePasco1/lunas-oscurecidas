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

/**
 * Send a Telegram message. Never throws — notification failures are logged and
 * swallowed so a Telegram outage can't crash the watcher loop.
 * Optionally sends a photo (e.g. a debug screenshot) when `photoPath` is given.
 */
export async function sendTelegram(
  text: string,
  opts: { silent?: boolean } = {}
): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: opts.silent ?? false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage failed: ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[telegram] sendMessage error:", err);
    return false;
  }
}
