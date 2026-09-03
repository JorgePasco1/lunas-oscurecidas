import type { Locator, Page } from "playwright";
import { finalizeBooking, fmtBookingResults } from "./booking.js";
import { config } from "./config.js";
import { pingHealthcheck } from "./health.js";
import {
  establishSession,
  isLoggedOut,
  launchBrowser,
  readAvailability,
  selectSede,
  selectSlot,
  setScrapeVerbose,
  sortSlots,
  type AlreadyBookedError,
  type BrowserHandle,
} from "./scraper.js";
import { loadState, saveState } from "./state.js";
import { esc, sendTelegram } from "./telegram.js";
import { limaDateYMD, limaNow } from "./time.js";
import { fmtSlots, materialSig, persistIfMaterial } from "./watcher.js";
import {
  slotKey,
  type Account,
  type BookingResult,
  type SlotInfo,
  type WatcherState,
} from "./types.js";

const MENU_URL = config.site.menuUrl;

function log(...a: unknown[]): void {
  console.log("[warm]", ...a);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One always-on browser: logged in and parked at the Reserva de Citas modal for
 * a single account. Polls availability in-place and, when told, books in-place
 * (~2-3s) rather than building a cold session (~20s). Self-heals on logout.
 */
class WarmSession {
  readonly account: Account;
  private handle!: BrowserHandle;
  private modal!: Locator;
  private fecha!: Locator;
  private hora!: Locator;
  private sedeMatch = "";
  /** false = needs (re)establishing before the next poll can read slots. */
  alive = false;
  /** How many times this session had to re-login (surfaced in the heartbeat). */
  reauths = 0;
  /** Set once this account is finished (already had, or just got, its cita).
   *  A done session is never polled and its browser is stopped to free RAM. */
  done = false;
  /** True once we discover (not via our own booking flow) that this account
   *  already has a programmed cita — carries the date/time to record + announce. */
  bookedInfo?: { fecha: string; hora: string };
  /** True once its browser has been closed (booked → freed). */
  stopped = false;

  constructor(account: Account) {
    this.account = account;
  }

  private get page(): Page {
    return this.handle.page;
  }

  /** Build the browser and park at the modal. Throws on failure (caller decides). */
  async start(): Promise<void> {
    this.handle = await launchBrowser();
    await this.establish();
    if (this.done) log(`${this.account.label} already booked — not parking`);
    else log(`ready: ${this.account.label} parked at modal`);
  }

  /** (Re)run login → expediente → modal → select sede on the current page. If the
   *  account already has a cita (reserve UI hidden), flag it done instead. */
  private async establish(): Promise<void> {
    try {
      this.modal = await establishSession(this.page, this.account);
    } catch (err) {
      const ab = (err as Partial<AlreadyBookedError>).alreadyBooked;
      if (ab) {
        this.bookedInfo = ab;
        this.done = true;
        this.alive = false;
        log(`${this.account.label} already has cita ${ab.fecha} ${ab.hora} — done`);
        return;
      }
      throw err;
    }
    const r = await selectSede(this.page, this.modal);
    this.fecha = r.fecha;
    this.hora = r.hora;
    this.sedeMatch = r.sedeMatch;
    this.alive = true;
  }

  /** Recover a lost session: re-login on the same browser; if the page/browser
   *  itself is dead, rebuild the browser from scratch. */
  private async reauth(): Promise<void> {
    this.reauths += 1;
    this.alive = false;
    try {
      await this.establish();
      log(`reauthenticated ${this.account.label} (#${this.reauths})`);
    } catch (err) {
      log(`reauth on same browser failed (${String(err)}); rebuilding browser`);
      await this.handle.close().catch(() => {});
      this.handle = await launchBrowser();
      await this.establish();
      log(`rebuilt session ${this.account.label} (#${this.reauths})`);
    }
  }

  /** Poll current availability. Never throws: on any failure it flags the
   *  session and attempts a reauth so the next poll is ready. */
  async safePoll(): Promise<{ ok: boolean; slots: SlotInfo[] }> {
    try {
      if (!this.alive) await this.reauth();
      if (this.done) return { ok: true, slots: [] }; // became booked during reauth
      if (await isLoggedOut(this.page)) {
        throw new Error("session expired (login page shown)");
      }
      const slots = await readAvailability(this.page, this.modal);
      this.alive = true;
      return { ok: true, slots };
    } catch (err) {
      log(`poll failed for ${this.account.label}: ${String(err)}`);
      this.alive = false;
      await this.reauth().catch((e) => log(`reauth failed: ${String(e)}`));
      return { ok: false, slots: [] };
    }
  }

  /** Book `target` in-place. Never throws — returns a BookingResult. Forces a
   *  clean re-establish on the next poll (the modal is dirty after a booking). */
  async safeBook(target: SlotInfo): Promise<BookingResult> {
    try {
      const ok = await selectSlot(
        this.page,
        this.fecha,
        this.hora,
        target.fecha,
        target.hora
      );
      if (!ok) {
        return {
          account: this.account.label,
          ok: false,
          dryRun: false,
          reason: `slot ${target.fecha} ${target.hora} vanished before booking`,
        };
      }
      const slot: SlotInfo = {
        sede: this.sedeMatch,
        fecha: target.fecha,
        hora: target.hora,
        cupos: target.cupos,
      };
      return await finalizeBooking(this.page, this.account, slot);
    } catch (err) {
      return {
        account: this.account.label,
        ok: false,
        dryRun: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // The modal is now dirty (confirm panel / error). Force a clean reparK.
      this.alive = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.handle?.close().catch(() => {});
  }
}

/** True once the PREFER_FECHA hold-out deadline (PREFER_UNTIL, a Lima date) has
 *  arrived — from then on we book the earliest slot on any date. */
export function pastFallbackDeadline(today: string = limaDateYMD()): boolean {
  const until = config.booking.preferUntil;
  return !!until && today >= until; // YYYY-MM-DD strings compare lexically
}

/** The preference to apply right now: the configured one until the deadline,
 *  then an empty preference (earliest anywhere). */
export function effectivePrefs(): { preferFecha: string; preferHora: string } {
  if (pastFallbackDeadline()) return { preferFecha: "", preferHora: "" };
  return { preferFecha: config.booking.preferFecha, preferHora: config.booking.preferHora };
}

/** Order a session's slots by booking preference. With a preferred fecha set,
 *  restrict to THAT date (preferred hora first, then earliest other hour that
 *  day); otherwise earliest-first across all dates. */
export function acceptableSlots(
  slots: SlotInfo[],
  prefs: { preferFecha: string; preferHora: string } = config.booking
): SlotInfo[] {
  const sorted = sortSlots(slots);
  if (!prefs.preferFecha) return sorted;
  const sameDay = sorted.filter((s) => s.fecha === prefs.preferFecha);
  if (!prefs.preferHora) return sameDay;
  const exact = sameDay.filter((s) => s.hora === prefs.preferHora);
  const rest = sameDay.filter((s) => s.hora !== prefs.preferHora);
  return [...exact, ...rest];
}

/** Highest-preference slot that ALL bookable sessions currently see with room
 *  for the whole group (cupos >= n) — identical-or-nothing. Returns null (book
 *  none) if no acceptable slot is visible to everyone with enough room. */
export function sharedTarget(
  perSession: SlotInfo[][],
  n: number,
  prefs: { preferFecha: string; preferHora: string } = config.booking
): SlotInfo | null {
  if (perSession.length === 0) return null;
  const ordered = acceptableSlots(perSession[0], prefs);
  for (const c of ordered) {
    if (c.cupos < n) continue;
    const seenByAll = perSession
      .slice(1)
      .every((list) =>
        list.some((s) => s.fecha === c.fecha && s.hora === c.hora && s.cupos >= n)
      );
    if (seenByAll) return c;
  }
  return null;
}

/** De-duplicate slots by (fecha|hora), keeping the max cupos seen. */
export function mergeSlots(lists: SlotInfo[][]): SlotInfo[] {
  const by = new Map<string, SlotInfo>();
  for (const list of lists) {
    for (const s of list) {
      const k = slotKey(s);
      const prev = by.get(k);
      if (!prev || s.cupos > prev.cupos) by.set(k, s);
    }
  }
  return sortSlots([...by.values()]);
}

/** Periodic "still alive" heartbeat, including per-session reauth counts. Uses
 *  the warm loop's own state object (never the watcher's, to avoid clobbering
 *  the state file from two owners). */
async function maybeHeartbeat(
  state: WatcherState,
  sessions: WarmSession[]
): Promise<void> {
  const now = Date.now();
  const intervalMs = config.schedule.heartbeatHours * 3600_000;
  const last = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : 0;
  if (now - last < intervalMs) return;

  const lastCheck = state.lastSuccessAt
    ? new Date(state.lastSuccessAt).toLocaleString("es-PE", {
        timeZone: "America/Lima",
      })
    : "—";
  const healthy = state.failureStreak === 0;
  const reauths = sessions
    .map((s) => `${s.account.label}: ${s.reauths}`)
    .join(", ");
  await sendTelegram(
    `${healthy ? "✅" : "⚠️"} <b>Watcher activo</b> (sesiones tibias)\n` +
      `Vigilando: <b>${esc(config.targetSede)}</b>\n` +
      `Última verificación OK: ${esc(lastCheck)}\n` +
      `Sondeos OK desde el último reporte: ${state.cyclesOkSinceHeartbeat}\n` +
      `Fallos consecutivos ahora: ${state.failureStreak}\n` +
      `Re-logins por cuenta: ${esc(reauths)}`,
    { silent: true }
  );
  state.lastHeartbeatAt = new Date(now).toISOString();
  state.cyclesOkSinceHeartbeat = 0;
  await saveState(state);
}

/**
 * Warm-session main loop. Keeps one logged-in browser per account parked at the
 * modal, polls every WARM_POLL_SECONDS, alerts on fresh cupos, and books the
 * whole group into an identical slot the instant one appears. Never returns.
 */
export async function runWarm(): Promise<void> {
  setScrapeVerbose(false); // silence per-poll "sede/fecha options" spam
  const pollMs = Math.max(3, config.warm.pollSeconds) * 1000;
  const state = await loadState();
  const sessions = config.accounts.map((a) => new WarmSession(a));

  // Graceful shutdown: close browsers so Chromium doesn't linger.
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await Promise.all(sessions.map((s) => s.stop()));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Bring every session up (a failure just leaves it flagged for reauth).
  await Promise.all(
    sessions.map((s) =>
      s.start().catch((e) => log(`start failed for ${s.account.label}: ${String(e)}`))
    )
  );

  const prefFecha = config.booking.preferFecha;
  const prefUntil = config.booking.preferUntil;
  log(
    `loop start — ${sessions.length} warm session(s), poll=${config.warm.pollSeconds}s, ` +
      `booking=${config.booking.enabled ? (config.booking.dryRun ? "DRY-RUN" : "LIVE") : "off"}` +
      (prefFecha
        ? `, prefer ${prefFecha} ${config.booking.preferHora}${
            prefUntil ? ` until ${prefUntil} then earliest-anywhere` : " (strict)"
          }`
        : "")
  );

  // Announce the one-time switch from "hold out for PREFER_FECHA" to "earliest
  // anywhere" so the user knows the strategy changed.
  let announcedWiden = pastFallbackDeadline();

  for (;;) {
    const cycleStart = Date.now();
    const sigBefore = materialSig(state);

    // Reconcile booked accounts: record any newly-discovered existing cita and
    // free the browser of any account that's finished (booked). This is what
    // stops us from hammering an already-booked account's hidden button.
    for (const s of sessions) {
      if (s.bookedInfo && !state.booked[s.account.label]) {
        state.booked[s.account.label] = {
          fecha: s.bookedInfo.fecha,
          hora: s.bookedInfo.hora,
          at: new Date().toISOString(),
        };
        await sendTelegram(
          `✅ <b>${esc(s.account.label)}</b> ya tiene cita reservada: ` +
            `<b>${esc(s.bookedInfo.fecha)} ${esc(s.bookedInfo.hora)}</b>.\n` +
            `<i>Dejo de intentar para esta cuenta.</i>`
        );
        log(`recorded ${s.account.label} as already booked`);
      }
      if (state.booked[s.account.label] && !s.stopped) {
        s.done = true;
        await s.stop();
        log(`stopped ${s.account.label} browser (booked → freeing RAM)`);
      }
    }

    const active = sessions.filter((s) => !state.booked[s.account.label] && !s.done);
    if (active.length === 0) {
      await persistIfMaterial(state, sigBefore);
      await maybeHeartbeat(state, sessions);
      await sleep(pollMs);
      continue;
    }

    // One-time notice when the hold-out deadline passes and we widen the search.
    if (!announcedWiden && pastFallbackDeadline()) {
      announcedWiden = true;
      log(`preference deadline ${prefUntil} reached — widening to earliest-anywhere`);
      await sendTelegram(
        `🔀 <b>Amplío la búsqueda</b> — pasó el ${esc(prefUntil)} sin cupo en ` +
          `<b>${esc(prefFecha)}</b> para ${active.map((s) => esc(s.account.label)).join(", ")}. ` +
          `Ahora reservo el <b>cupo más cercano en cualquier fecha</b>.`
      );
    }

    // Poll all active sessions in parallel.
    const polls = await Promise.all(active.map((s) => s.safePoll()));
    const anyOk = polls.some((p) => p.ok);

    // Health/degraded bookkeeping (whole cycle counts as one check).
    if (anyOk) {
      const wasDegraded = state.degradedNotified;
      state.failureStreak = 0;
      state.degradedNotified = false;
      state.lastSuccessAt = new Date().toISOString();
      state.cyclesOkSinceHeartbeat += 1;
      if (wasDegraded) {
        await sendTelegram(
          `✅ <b>Watcher recuperado</b> — las sesiones vuelven a leer el sitio con normalidad.`
        );
      }
    } else {
      state.failureStreak += 1;
      log(`whole cycle failed (streak ${state.failureStreak})`);
      if (
        state.failureStreak >= config.schedule.failureAlertThreshold &&
        !state.degradedNotified
      ) {
        await sendTelegram(
          `⚠️ <b>Watcher degradado</b>\n` +
            `Todas las sesiones fallan al leer el sitio (${state.failureStreak} sondeos seguidos).\n` +
            `<i>Probablemente el sitio está caído. Te aviso cuando se recupere.</i>`
        );
        state.degradedNotified = true;
      }
    }

    // Availability seen across all sessions (for alerting).
    const perSession = polls.map((p) => p.slots);
    const allSlots = mergeSlots(perSession);
    const currentKeys = new Set(allSlots.map(slotKey));
    const alreadyAlerted = new Set(state.alertedKeys);
    const fresh = allSlots.filter((s) => !alreadyAlerted.has(slotKey(s)));
    if (fresh.length > 0) {
      await sendTelegram(
        `🚨 <b>¡CUPOS DISPONIBLES!</b> 🚨\n` +
          `Sede: <b>${esc(config.targetSede)}</b>\n` +
          `Detectado: <b>${esc(limaNow())}</b>\n\n` +
          `${fmtSlots(fresh)}\n\n` +
          `👉 ${MENU_URL}`,
        { attempts: 6 }
      );
      log(`alerted ${fresh.length} fresh slot(s)`);
    }

    // ---- Auto-booking (identical-or-nothing, simultaneous) ----
    if (
      config.booking.enabled &&
      !config.booking.dryRun &&
      !state.bookingHalted &&
      allSlots.length > 0
    ) {
      // Only sessions whose poll succeeded have a live modal to book from now.
      const bookable = active.filter((_, i) => polls[i].ok);
      const slotsByBookable = bookable.map((s) => perSession[active.indexOf(s)]);

      const prefs = effectivePrefs();
      const plan = new Map<string, SlotInfo>();
      if (config.booking.sameSlot) {
        // Identical-or-nothing: one slot everyone can take, honoring preference.
        const shared = sharedTarget(slotsByBookable, bookable.length, prefs);
        if (shared) for (const s of bookable) plan.set(s.account.label, shared);
      } else {
        // Independent: each books its own highest-preference available slot.
        bookable.forEach((s, i) => {
          const t = acceptableSlots(slotsByBookable[i], prefs)[0];
          if (t) plan.set(s.account.label, t);
        });
      }

      if (plan.size > 0) {
        const target = [...plan.values()][0];
        log(
          `booking (LIVE) ${bookable.map((s) => s.account.label).join(", ")} ` +
            `-> ${target.fecha} ${target.hora}`
        );
        const results = await Promise.all(
          bookable.map((s) => s.safeBook(plan.get(s.account.label)!))
        );
        for (const r of results) {
          if (r.ok && !r.dryRun && r.slot) {
            state.booked[r.account] = {
              fecha: r.slot.fecha,
              hora: r.slot.hora,
              at: new Date().toISOString(),
            };
          }
        }
        await sendTelegram(
          `📩 <b>Intento de reserva</b>\n${fmtBookingResults(results)}`,
          { attempts: 6 }
        );

        // Identical-or-nothing guard: some booked, others not → halt.
        const succeeded = results.filter((r) => r.ok && !r.dryRun).length;
        if (succeeded > 0 && succeeded < bookable.length) {
          state.bookingHalted = true;
          await sendTelegram(
            `⚠️ <b>RESERVA PARCIAL</b> — se reservó para ${succeeded}/${bookable.length}. ` +
              `Detuve el auto-booking para no separarlos en horarios distintos. ` +
              `Coordina/cancela manualmente y avísame para reanudar.`,
            { attempts: 6 }
          );
        }
      }
    }

    state.alertedKeys = [...currentKeys];
    await persistIfMaterial(state, sigBefore);
    await maybeHeartbeat(state, sessions);
    if (anyOk) await pingHealthcheck();

    const elapsed = Date.now() - cycleStart;
    await sleep(Math.max(0, pollMs - elapsed));
  }
}
