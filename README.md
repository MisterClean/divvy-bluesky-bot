# Divvy Station Bluesky Bot

A one-shot TypeScript worker that monitors Chicago's Divvy station dataset and
publishes durable, image-backed announcements to
[`divvystationbot.bsky.social`](https://bsky.app/profile/divvystationbot.bsky.social).

The refactored worker uses:

- the City of Chicago Socrata JSON API as its station source;
- SQLite for station state, domain events, delivery retries, and run history;
- Protomaps rendered through MapLibre GL for static location images;
- Google Street View as an optional second image;
- the AT Protocol API for deterministic Bluesky record creation.

Publishing is disabled by default.

## Architecture

Each run performs four distinct steps:

1. Fetch and validate the complete station snapshot.
2. Reconcile it against SQLite and create durable events for new or newly
   electrified stations.
3. Queue a delivery for every event.
4. When publishing is enabled, drain up to `POST_LIMIT` ready deliveries.

Station state and delivery state are committed separately. A source, map,
Street View, or Bluesky failure therefore cannot silently discard an
announcement. The delivery remains queued with exponential backoff.

The first valid station snapshot initializes a silent baseline. It does not
announce every station already in the system.

## Requirements

- Node.js 24 LTS
- npm
- Chromium installed through Playwright for map rendering

For a local checkout:

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

## Configuration

The full configuration template is in `.env.example`.

Important safety settings:

- `PUBLISH_ENABLED=false` is the default.
- Bluesky credentials and Protomaps configuration are required before
  publishing can be enabled.
- Street View is independently controlled by `STREETVIEW_ENABLED`.

The default hosted Protomaps style is:

```text
https://api.protomaps.com/styles/v5/light/en.json?key=PROTOMAPS_KEY
```

Set `PROTOMAPS_STYLE_URL` instead when testing or using a self-hosted style.

## Commands

Run one fetch/reconcile/delivery cycle:

```bash
npm run dev -- run
```

Inspect station and delivery counts:

```bash
npm run dev -- status
```

Render a station already stored in the new database:

```bash
npm run dev -- render STATION_ID output/example.jpg
```

Import the current station baseline from the legacy production database:

```bash
DB_PATH=data/divvy-bot.sqlite3 \
  npm run dev -- import-legacy /path/to/legacy-divvy-stations.db
```

The target database must be empty. Importing creates a silent baseline and no
pending announcements.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The test suite covers safe configuration defaults, first-run behavior,
idempotent station discovery, committed electrification transitions, retry
state, and post content.

## Docker and Lightsail

Build the production image:

```bash
docker build -t divvy-bluesky-bot:2 .
```

On the Lightsail host:

1. Create `/var/lib/divvy-bot` and make it writable by UID `1000`.
2. Copy `.env.example` to `/etc/divvy-bot.env` and fill in production values.
3. Set `DB_PATH=/var/lib/divvy-bot/bot.sqlite3`.
4. Import the production legacy database before the first refactored run.
5. Install `deploy/divvy-bot.service` and `deploy/divvy-bot.timer` under
   `/etc/systemd/system`.
6. Leave `PUBLISH_ENABLED=false` during the shadow period.

The included timer runs at 12:00 UTC daily, matching the bot's current posting
window. Enable it with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now divvy-bot.timer
```

Before cutover, inspect several shadow runs with:

```bash
sudo systemctl start divvy-bot.service
sudo journalctl -u divvy-bot.service
```

Only set `PUBLISH_ENABLED=true` after disabling the legacy cron job and
confirming the pending delivery count is expected.

## Legacy implementation

The original Python files and tracked 2024 SQLite snapshot remain in this
branch temporarily to support production-state comparison and migration. They
are not invoked by the TypeScript worker and should be removed after the
Lightsail cutover is verified.
