# Raspberry Pi setup (the real host)

The PNP site **refuses connections from non-Peru IPs** (confirmed: fly/São Paulo gets
`Connection refused`, a Peru IP gets HTTP 200). So the watcher must run from a Peru
internet connection. A **Raspberry Pi 4** on your home network is the host.

Three resilience layers guard against outages:
1. The watcher treats "no internet" like "site down" — retries next cycle, never crashes.
2. **systemd** auto-starts it on boot and restarts it on any crash (`Restart=always`).
3. A **healthchecks.io** dead-man's-switch alerts *you* if the Pi/internet goes down
   (the one case our own Telegram can't cover).

---

## 0. Flash the OS (once)

1. On your Mac, install **Raspberry Pi Imager** (https://www.raspberrypi.com/software/).
2. Choose **Raspberry Pi OS (64-bit)** — Lite is enough (headless, no desktop).
   > 64-bit is required for Playwright's Chromium on ARM.
3. In Imager's ⚙️ settings before writing:
   - Set a **hostname** (e.g. `lunaspi`)
   - **Enable SSH** (password or key)
   - Set **username** `pi` and a password
   - Configure **Wi-Fi** (or use ethernet) + your country/locale
4. Write the SD card, boot the Pi, wait ~1 min.

## 1. SSH in (from your Mac)

```bash
ssh pi@lunaspi.local     # or ssh pi@<pi-ip-address>
```

## 2. Install Node 22 + pnpm (system-wide, so systemd can find node)

```bash
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version           # expect v22.x
sudo corepack enable     # provides pnpm
```

## 3. Get the code onto the Pi

Option A — clone from your git remote (if you push it there):
```bash
cd ~
git clone <your-repo-url> lunas-oscurecidas
cd lunas-oscurecidas
```
Option B — copy from your Mac with rsync (run this **on your Mac**):
```bash
rsync -av --exclude node_modules --exclude dist --exclude data \
  ~/dev/projects/lunas-oscurecidas/ pi@lunaspi.local:/home/pi/lunas-oscurecidas/
```

## 4. Install deps + Chromium (with OS libraries)

```bash
cd ~/lunas-oscurecidas
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium     # arm64 Chromium + apt deps
pnpm run build
```

## 5. Create the `.env`

```bash
nano .env
```
Fill in (see `.env.example` for all keys):
```
PNP_DNI=70886597
PNP_CLAVE=your-password
TELEGRAM_BOT_TOKEN=8301731075:AAG...
TELEGRAM_CHAT_ID=1542531417
TARGET_SEDE=LIMA-LA VICTORIA
HEALTHCHECK_URL=          # from step 7, paste after creating the check
HEADLESS=true
```

## 6. Smoke-test once before installing the service

```bash
DUMP_DOM=false pnpm check     # should end with "no cupos available right now"
```
If that works, the Pi can reach the site and log in. 🎉

## 7. Set up the dead-man's-switch (healthchecks.io, free)

1. Sign up at https://healthchecks.io (free tier).
2. Create a check: **period = 5 min**, **grace = 15 min** (alerts if no ping for ~20 min).
3. Add your email (and/or Telegram) as the notification method.
4. Copy the check's **ping URL** and paste it as `HEALTHCHECK_URL=` in `.env`.

## 8. Install the systemd service (auto-start + auto-restart)

```bash
sudo cp ~/lunas-oscurecidas/deploy/lunas-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lunas-watcher
```

Check it:
```bash
systemctl status lunas-watcher
journalctl -u lunas-watcher -f      # live logs; watch a cycle run
```
You should get the "🟢 Watcher iniciado" Telegram message.

## Everyday operations

```bash
journalctl -u lunas-watcher -f          # follow logs
sudo systemctl restart lunas-watcher    # restart
sudo systemctl stop lunas-watcher       # stop
```

Update after code changes (rsync/pull the new code, then):
```bash
cd ~/lunas-oscurecidas && pnpm install --frozen-lockfile && pnpm run build \
  && sudo systemctl restart lunas-watcher
```

## Outage behaviour (what to expect)

- **Brief internet blip:** cycles fail quietly, then resume; you may get a
  "⚠️ degraded" then "✅ recovered" if it lasts past the threshold.
- **Power outage / reboot:** systemd restarts the watcher automatically when the Pi
  boots; state on disk is intact.
- **Prolonged Pi/internet down:** healthchecks.io stops receiving pings and emails you.
  When it recovers, pings resume.
