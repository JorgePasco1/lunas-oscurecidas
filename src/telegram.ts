import { config } from "./config.js";

const API_BASE = `https://api.telegram.org/bot${config.telegram.token}`;

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
        parse_mode: "Markdown",
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
