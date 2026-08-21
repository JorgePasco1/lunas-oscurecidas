/** A single available appointment slot detected in the modal. */
export interface SlotInfo {
  sede: string;
  fecha: string;
  hora: string;
  cupos: number;
}

/** One PNP account we log in as (the user, a friend, …). */
export interface Account {
  /** Human label for messages/state, e.g. "Jorge". */
  label: string;
  tipoDoc: string;
  documento: string;
  clave: string;
  /** Expediente number to open; empty = first row. */
  expediente: string;
}

/** A booking that was made (or, in dry-run, would have been made). */
export interface BookingRecord {
  fecha: string;
  hora: string;
  at: string; // ISO timestamp
}

/** Result of one booking attempt for one account. */
export interface BookingResult {
  account: string;
  ok: boolean;
  dryRun: boolean;
  slot?: SlotInfo;
  reason?: string;
  screenshot?: string;
  /** Extra info surfaced in messages, e.g. the solved captcha. */
  note?: string;
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
  /** Confirmed bookings, keyed by account label. Once present, that account is
   *  done and we stop trying to book for it. Only set for real (non-dry-run)
   *  bookings. */
  booked: Record<string, BookingRecord>;
}

export const initialState: WatcherState = {
  alertedKeys: [],
  failureStreak: 0,
  degradedNotified: false,
  lastHeartbeatAt: null,
  lastSuccessAt: null,
  cyclesOkSinceHeartbeat: 0,
  booked: {},
};

/** Stable identity for a slot, used for alert de-duplication. */
export function slotKey(s: SlotInfo): string {
  return `${s.fecha}|${s.hora}`;
}
