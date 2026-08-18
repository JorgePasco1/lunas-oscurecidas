/** A single available appointment slot detected in the modal. */
export interface SlotInfo {
  sede: string;
  fecha: string;
  hora: string;
  cupos: number;
}

/** Result of one scrape cycle. Success and failure are never conflated: a site
 *  error returns `ok: false` (not an empty `available` list). */
export type ScrapeResult =
  | { ok: true; available: SlotInfo[] }
  | { ok: false; stage: string; reason: string; screenshot?: string };

/** Persisted watcher state (survives restarts on the data volume). */
export interface WatcherState {
  /** Keys (fecha|hora) already alerted, so we don't spam while a slot lingers. */
  alertedKeys: string[];
  /** Consecutive scrape failures. */
  failureStreak: number;
  /** Whether a "degraded" alert has already been sent for the current outage. */
  degradedNotified: boolean;
  /** ISO timestamp of the last heartbeat sent. */
  lastHeartbeatAt: string | null;
  /** ISO timestamp of the last successful scrape. */
  lastSuccessAt: string | null;
  /** Successful cycles counted since the last heartbeat (for the heartbeat text). */
  cyclesOkSinceHeartbeat: number;
}

export const initialState: WatcherState = {
  alertedKeys: [],
  failureStreak: 0,
  degradedNotified: false,
  lastHeartbeatAt: null,
  lastSuccessAt: null,
  cyclesOkSinceHeartbeat: 0,
};

/** Stable identity for a slot, used for alert de-duplication. */
export function slotKey(s: SlotInfo): string {
  return `${s.fecha}|${s.hora}`;
}
