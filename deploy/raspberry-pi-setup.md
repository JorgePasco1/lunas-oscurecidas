# Raspberry Pi setup (the production host)

The PNP site **refuses connections from non-Peru IPs** (confirmed: fly/São Paulo gets
`Connection refused`; a Peru IP gets HTTP 200). So the watcher runs from a **Raspberry
Pi 4** on home internet in Peru.

## This Pi (verified 2026-08-21)

| Item | Value |
|---|---|
| Host / user | `JorgePi` / `jorgepasco1` |
| SSH alias (Mac) | `ssh jorgepi` (→ `192.168.0.56`, ed25519 key) |
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
2. New check: **period 5 min**, **grace 15 min** (alerts after ~20 min of silence).
3. Add email (and/or Telegram) as the notification.
4. Paste the ping URL into `HEALTHCHECK_URL=` in `.env`.

The watcher pings it every cycle. If the Pi loses power/internet, pings stop and
healthchecks.io alerts you — the one failure the bot's own Telegram can't send.

## 8. Cap journald writes (protect the microSD)

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=50M\nSystemMaxFileSize=10M\nRuntimeMaxUse=50M\n' \
  | sudo tee /etc/systemd/journald.conf.d/cap.conf
sudo systemctl restart systemd-journald
```

## 9. Install the service (auto-start + auto-restart)

```bash
sudo cp ~/lunas-oscurecidas/deploy/lunas-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lunas-watcher
systemctl status lunas-watcher
journalctl -u lunas-watcher -f      # watch a cycle; expect "🟢 Watcher iniciado" in Telegram
```

---

## Open item: pin the IP

Set a **DHCP reservation** for the Pi's WiFi MAC on your router so `192.168.0.56`
survives outages (otherwise the `jorgepi` alias can break after a long downtime).
Even if it changes, **Raspberry Pi Connect** (`connect.raspberrypi.com`) still reaches
the shell, since it doesn't depend on the LAN IP.

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
- **Prolonged Pi/internet down:** healthchecks.io stops getting pings → it emails you.
