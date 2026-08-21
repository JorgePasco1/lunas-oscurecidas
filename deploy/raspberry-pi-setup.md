# Raspberry Pi setup (the production host)

The PNP site **refuses connections from non-Peru IPs** (confirmed: fly/São Paulo gets
`Connection refused`; a Peru IP gets HTTP 200). So the watcher runs from a **Raspberry
Pi 4** on home internet in Peru.

## This Pi (verified 2026-08-21)

| Item | Value |
|---|---|
| Host / user | `JorgePi` / `jorgepasco1` |
| SSH alias (Mac) | `ssh jorgepi` (→ `192.168.0.56`, ed25519 key); `ssh jorgepi-mdns` (→ `JorgePi.local`, survives an IP change) |
| WiFi | `CASAAREQUIPA-2.4GHZ`, ch 11 — **not** the 5GHz profile (see §10) |
| OS | Raspberry Pi OS 64-bit **Desktop**, Debian 13 (trixie), aarch64 |
| Chromium | ships with the image (system package — we use it directly) |
| Remote (off-LAN) | Raspberry Pi Connect (installed, signed in, verified) |

> ⚠️ **SSH KEX caveat.** The Mac's OpenSSH 10.2 defaults to a post-quantum KEX that
> **hangs** against this Pi. The `jorgepi` alias in `~/.ssh/config` pins
> `KexAlgorithms curve25519-sha256`. Any tool opening its own SSH connection
> (`rsync`, `scp`, `git+ssh`) must use the `jorgepi` alias **or** pass
> `-o KexAlgorithms=curve25519-sha256`. Plain `rsync host:...` will hang.

Design constraints baked into the code and this guide: **headless only**, **systemd with
`Restart=always`** (survives the power cuts this box will see — no UPS, operator
traveling), **minimize microSD writes** (old card), **retries on every outbound call**
(2.4GHz WiFi at -67 dBm, no wired fallback).

---

## 1. SSH in (from your Mac)

```bash
ssh jorgepi
```

## 2. Install Node 22 + pnpm (system-wide, so systemd finds `node`)

`sudo` needs your password on this box.

```bash
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version            # expect v22.x
sudo corepack enable      # provides pnpm

# Confirm the system Chromium path (used instead of downloading Playwright's):
which chromium || which chromium-browser
```
Note that path — usually `/usr/bin/chromium` on trixie.

## 3. Copy the code onto the Pi (from your Mac)

Use the `jorgepi` alias so rsync's SSH doesn't hang on the KEX:

```bash
rsync -av --exclude node_modules --exclude dist --exclude data \
  ~/dev/projects/lunas-oscurecidas/ jorgepi:/home/jorgepasco1/lunas-oscurecidas/
```
(Or `git clone` if you push to a remote.)

## 4. Install deps + build (no browser download)

Back on the Pi:
```bash
cd ~/lunas-oscurecidas
pnpm install --frozen-lockfile
pnpm run build
```
We deliberately **skip** `playwright install` — we point Playwright at the system
Chromium via `CHROMIUM_PATH` (next step). That avoids a ~150MB SD write and the
Debian-trixie dependency mismatch.

## 5. Create `.env`

```bash
nano .env
```
```
PNP_DNI=70886597
PNP_CLAVE=your-password
TELEGRAM_BOT_TOKEN=8301731075:AAG...
TELEGRAM_CHAT_ID=1542531417
TARGET_SEDE=LIMA-LA VICTORIA
HEADLESS=true
CHROMIUM_PATH=/usr/bin/chromium     # the path from step 2
HEALTHCHECK_URL=                    # from step 7
```

## 6. Smoke-test once

```bash
DUMP_DOM=false pnpm check
```
Expected: ends with `no cupos available right now`. If it logs in and reads the modal,
the Pi can reach the site with the system Chromium. 🎉
(If Chromium fails to launch, fall back to Playwright's build: `pnpm exec playwright
install chromium` and remove `CHROMIUM_PATH` from `.env`.)

## 7. Dead-man's-switch (healthchecks.io, free)

1. Sign up at https://healthchecks.io.
2. New check: **period 2 min** (match `CHECK_CRON`), **grace 10 min** (alerts after
   ~12 min of silence).
3. Add email (and/or Telegram) as the notification.
4. Paste the ping URL into `HEALTHCHECK_URL=` in `.env`.

The watcher pings it every cycle. If the Pi loses power/internet, pings stop and
healthchecks.io alerts you — the one failure the bot's own Telegram can't send.

## 8. Cap journald writes (protect the microSD)

> The obvious version of this step **silently does nothing**. Raspberry Pi OS ships
> `/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf` with
> `Storage=volatile`, so the journal lives in tmpfs: `SystemMaxUse=` is inert and
> **every reboot wipes the logs**. rsyslog isn't installed either, so without the
> `Storage=` line below there is no post-crash record of anything at all.

Drop-ins are merged in **filename** order across `/etc` and `/usr`, so the override
has to sort after `40-`:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/99-unattended.conf >/dev/null <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=50M
SystemMaxFileSize=10M
SyncIntervalSec=5m
EOF
sudo systemctl restart systemd-journald
sudo journalctl --flush          # migrates /run/log/journal -> /var/log/journal
```

Verify it actually moved (this is the part people skip):

```bash
sudo journalctl --header | grep -m1 'File path'   # must say /var/log/journal/...
journalctl --list-boots                           # must list more than boot 0
```

50M capped against 21G free is a rounding error, and this host logs ~1.5k messages
an hour, so the write cost is negligible. `SyncIntervalSec=5m` batches writes to
spare the card; journald still fsyncs immediately on `CRIT`/`ALERT`/`EMERG`, so the
messages that explain a crash are never the ones lost.

## 9. Install the service (auto-start + auto-restart)

```bash
sudo cp ~/lunas-oscurecidas/deploy/lunas-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lunas-watcher
systemctl status lunas-watcher
journalctl -u lunas-watcher -f      # watch a cycle; expect "🟢 Watcher iniciado" in Telegram
```

---

## 10. Unattended-host hardening (verified 2026-08-21)

Nobody can power-cycle this box once the owner travels, so every failure mode has to
recover on its own.

### Hardware watchdog — already on, but verify rather than assume

Raspberry Pi OS enables it for you via
`/usr/lib/systemd/system.conf.d/40-rpi-enable-watchdog.conf`
(`RuntimeWatchdogSec=1m`, `RebootWatchdogSec=2m`). **No `config.txt` edit is needed** —
`bcm2835-wdt` is built in and `/dev/watchdog0` already exists. Don't touch
`/boot/firmware/config.txt` for this; a typo there costs you a device you can't reach.

```bash
cat /sys/class/watchdog/watchdog0/state          # active
systemctl show -p RuntimeWatchdogUSec            # 1min
sudo lsof /dev/watchdog0                         # systemd, PID 1
```

Leave the timeout at **60s**. The BCM2835's hardware counter tops out near 15s and the
kernel emulates anything longer, so a *dead kernel* still resets in ~15s regardless;
the 60s only bounds how long a stalled-but-alive systemd gets. Tightening it to 15s (as
earlier notes suggested) buys nothing on the dead-kernel path and risks a reboot loop
if this five-year-old card stalls on a write.

### Escalate a wedged kernel into a reboot

The gap the watchdog does *not* cover: on an **oops** the kernel limps on, systemd keeps
petting the watchdog, so it never fires and the box sits half-broken forever. Defaults
are `kernel.panic=0` (halt forever) and `kernel.panic_on_oops=0`.

```bash
sudo tee /etc/sysctl.d/99-unattended-recovery.conf >/dev/null <<'EOF'
kernel.panic = 10
kernel.panic_on_oops = 1
EOF
sudo sysctl --system
```

### Proof it works

Tested by forcing a real kernel panic with `kernel.panic=0` set at runtime, so the
kernel **could not** reboot itself and only the hardware watchdog could recover it:

```bash
# destructive - only run this while you can still physically reach the Pi
echo 1 | sudo tee /proc/sys/kernel/sysrq
echo 0 | sudo tee /proc/sys/kernel/panic      # runtime only; sysctl.d restores 10 on boot
sudo systemd-run --on-active=5 --unit=panic-test bash -c 'sync; echo c > /proc/sysrq-trigger'
```

Result: host died instantly, **came back on its own in 42s**, no human action. Boot ID
changed, zero failed units, and the WiFi profile, sysctls and persistent journal all
survived the hard reset. The persistent journal held boot `-1` right up to the panic —
which is exactly the forensic trail §8 exists to provide.

Caveat: `/sys/class/watchdog/watchdog0/bootstatus` still reads `0` afterwards — this
driver doesn't report `WDIOF_CARDRESET` on a Pi 4, so **don't** use it as your evidence.
The proof is by elimination: with `kernel.panic=0` nothing else could have reset the board.

### WiFi: moved off the 5GHz DFS channel

The Pi was on `CASAAREQUIPA-5GHZ`, **channel 132 — a DFS channel**. The AP is legally
required to vacate a DFS channel when it detects radar, dropping every client while it
rehunts. That is a bad property for a box nobody can reboot. 2.4GHz also measured
stronger from this location (67 vs 51).

Change priorities rather than deleting the old profile — NetworkManager then falls back
on its own if the preferred network won't associate:

```bash
sudo nmcli con modify "CASAAREQUIPA-2.4GHZ" connection.autoconnect yes connection.autoconnect-priority 10
sudo nmcli con modify "netplan-wlan0-CASAAREQUIPA-5GHZ" connection.autoconnect yes connection.autoconnect-priority 0
sudo systemd-run --unit=wifi-switch nmcli con up "CASAAREQUIPA-2.4GHZ"   # detached: survives your SSH dying
```

`systemd-run` matters — you are changing the link you are connected over, and a bare
`nmcli con up` dies with your session partway through and can leave `wlan0` half
configured.

NM's fallback only covers *failure to associate*. For the nastier case — associates fine
but has no working internet — arm a one-shot revert before you switch, then let it
expire once you've confirmed connectivity:

```bash
sudo systemd-run --on-active=5min --unit=wifi-revert /usr/local/sbin/wifi-revert.sh
```

(`/usr/local/sbin/wifi-revert.sh` is on the Pi; it pings out and restores the 5GHz
priority only if there's no connectivity. It logged `connectivity OK ... keeping it`
and no-opped, as intended.)

Result: on ch 11 at 540 Mbit/s, `nmcli networking connectivity` = `full`, and the DHCP
lease stayed `192.168.0.56` because the MAC didn't change. Survived the forced hard
reset above still on 2.4GHz, which is the only proof that matters.

> Known interference: neighbouring AP **"PATTY"** sits on channel 11 at signal 99 —
> louder than this network on the same channel, and the likely cause of the intermittent
> drops. Channel 1 is clear. Moving it needs the router admin UI (owner's credentials).

### Deliberately NOT enabled

`unattended-upgrades` is left uninstalled. With no physical access, an automatic kernel
or firmware update that breaks boot is unrecoverable. Patch by hand over SSH instead.

## Open item: pin the IP

Set a **DHCP reservation** for the Pi's WiFi MAC on your router so `192.168.0.56`
survives outages (otherwise the `jorgepi` alias can break after a long downtime).
Needs router admin access — still open.

Two mitigations are already in place if it does move:

- `ssh jorgepi-mdns` resolves `JorgePi.local` over mDNS, so it survives an IP change.
- **Raspberry Pi Connect** (`connect.raspberrypi.com`) reaches the shell without the
  LAN at all.

## Everyday operations

```bash
journalctl -u lunas-watcher -f              # follow logs
sudo systemctl restart lunas-watcher        # restart
```
Update after code changes — rsync/pull, then on the Pi:
```bash
cd ~/lunas-oscurecidas && pnpm install --frozen-lockfile && pnpm run build \
  && sudo systemctl restart lunas-watcher
```

## Outage behaviour

- **WiFi blip:** cycle retries in-place (nav + Telegram have backoff); if it lasts past
  the threshold you get "⚠️ degradado" then "✅ recuperado".
- **Power cut / reboot:** systemd restarts the watcher on boot; state on disk is intact
  (atomic writes survive a mid-write power loss).
- **Kernel panic or hard lock:** nothing in userspace runs, so `Restart=` can't help.
  `panic_on_oops` turns a wedged kernel into a panic, `kernel.panic=10` reboots it, and
  the hardware watchdog resets the board if even that fails. Measured recovery from a
  forced panic: **42s, unattended** (§10).
- **Prolonged Pi/internet down:** healthchecks.io stops getting pings → it emails you.
