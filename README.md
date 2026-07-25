# Divvy Station Bluesky Bot

A one-shot TypeScript worker that monitors Chicago's Divvy station dataset and
publishes durable, image-backed announcements to
[`divvystationbot.bsky.social`](https://bsky.app/profile/divvystationbot.bsky.social).

The refactored worker uses:

- the City of Chicago Socrata JSON API as its station source;
- SQLite for station state, domain events, delivery retries, and run history;
- Protomaps Light rendered through MapLibre GL for 4:5 announcement images;
- Google Street View as an optional second image;
- the AT Protocol API for deterministic Bluesky record creation.

Station announcements alternate between civic and nightline visual treatments.
The chosen treatment is stored with each delivery, so retries render the same
card instead of changing styles.

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
- Chrome or Chromium for MapLibre rendering through the native
  `agent-browser` CLI

For a local checkout:

```bash
npm install
npx agent-browser install
cp .env.example .env
```

`agent-browser` also discovers an existing Chrome or Chromium installation.
The production Alpine image uses system Chromium plus Alpine's matching
SwiftShader package for software WebGL rather than downloading another
browser.

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
The prepared cards use a `1080x1350` viewport and `MAP_PIXEL_RATIO=1`, producing
an exact 1080x1350 image. Civic cards use `MAP_ZOOM=17`; nightline cards use
`MAP_NIGHTLINE_ZOOM=17.5`.

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
legacy database import, idempotent station discovery, committed
electrification transitions, retry state, browser orchestration, secret
redaction, and post content.

## Docker and Lightsail

Build the production image:

```bash
docker buildx build \
  --platform linux/amd64 \
  --load \
  -t divvy-bluesky-bot:2.0.0 \
  .
```

On the Lightsail host:

1. Create `/var/lib/divvy-bot` and make it writable by UID `1000`.
2. Copy `.env.example` to `/etc/divvy-bot.env` and fill in production values.
3. Set `DB_PATH=/var/lib/divvy-bot/bot.sqlite3`.
4. Import the production legacy database before the first refactored run.
5. Install `deploy/divvy-bot.service` and `deploy/divvy-bot.timer` under
   `/etc/systemd/system`.
6. Optionally set an immutable registry digest in
   `/etc/divvy-bot-image.env` as `DIVVY_BOT_IMAGE=...@sha256:...`.
7. Leave `PUBLISH_ENABLED=false` during the shadow period.

The included timer runs at 00:00, 06:00, 12:00, and 18:00 UTC, matching the
legacy PM2 schedule. Enable it with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now divvy-bot.timer
```

Before cutover, inspect several shadow runs with:

```bash
sudo systemctl start divvy-bot.service
sudo journalctl -u divvy-bot.service
```

Use a disposable database for shadow runs. After the legacy PM2 schedule is
disabled, create a fresh target database from a final, integrity-checked
production backup; do not promote the shadow database.

Only set `PUBLISH_ENABLED=true` after disabling the legacy cron job and
confirming the pending delivery count is expected.

## Legacy implementation

The original Python files and tracked 2024 SQLite snapshot remain in this
branch temporarily to support production-state comparison and migration. They
are not invoked by the TypeScript worker, must not be used as the production
migration source, and should be removed after the Lightsail cutover is
verified.
