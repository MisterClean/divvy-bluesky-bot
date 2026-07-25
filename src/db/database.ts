import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TID } from "@atproto/common-web";
import BetterSqlite3, { type Database as SqliteDatabase } from "better-sqlite3";
import type {
  AnnouncementStyle,
  StationEventPayload,
  StationEventType,
  StationSnapshot,
} from "../domain/station.js";
import { stationStateHash } from "../domain/station.js";
import { migrations } from "./migrations.js";

interface StationRow {
  id: string;
  station_name: string;
  short_name: string;
  total_docks: number;
  docks_in_service: number;
  status: string;
  latitude: number;
  longitude: number;
  is_electric: number;
  state_hash: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  record_key: string;
  announcement_style: AnnouncementStyle;
  status: DeliveryStatus;
  attempts: number;
  payload: string;
}

interface CountRow {
  count: number;
}

export type DeliveryStatus =
  | "pending"
  | "processing"
  | "retrying"
  | "delivered";

export interface ReconciliationSummary {
  baselineCreated: boolean;
  stationsProcessed: number;
  discovered: number;
  electrified: number;
  eventsCreated: number;
}

export interface PendingDelivery {
  id: string;
  eventId: string;
  recordKey: string;
  announcementStyle: AnnouncementStyle;
  status: DeliveryStatus;
  attempts: number;
  payload: StationEventPayload;
}

export interface DeliveryCounts {
  pending: number;
  processing: number;
  retrying: number;
  delivered: number;
}

export class BotDatabase {
  readonly sqlite: SqliteDatabase;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.sqlite = new BetterSqlite3(databasePath);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  getStation(stationId: string): StationSnapshot | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM stations WHERE id = ?")
      .get(stationId) as StationRow | undefined;

    return row ? stationFromRow(row) : undefined;
  }

  getAllStations(): StationSnapshot[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM stations ORDER BY id")
      .all() as StationRow[];

    return rows.map(stationFromRow);
  }

  getStationCount(): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM stations")
      .get() as CountRow;
    return row.count;
  }

  reconcileStations(
    incoming: StationSnapshot[],
    observedAt = new Date().toISOString(),
  ): ReconciliationSummary {
    return this.sqlite.transaction(() => {
      const existingRows = this.sqlite
        .prepare("SELECT * FROM stations")
        .all() as StationRow[];
      const existingById = new Map(
        existingRows.map((row) => [row.id, row] as const),
      );
      const baselineCreated = existingRows.length === 0;
      let discovered = 0;
      let electrified = 0;
      let eventsCreated = 0;

      const upsert = this.sqlite.prepare(`
        INSERT INTO stations (
          id, station_name, short_name, total_docks, docks_in_service,
          status, latitude, longitude, is_electric, state_hash,
          first_seen_at, last_seen_at
        ) VALUES (
          @id, @stationName, @shortName, @totalDocks, @docksInService,
          @status, @latitude, @longitude, @isElectric, @stateHash,
          @firstSeenAt, @lastSeenAt
        )
        ON CONFLICT(id) DO UPDATE SET
          station_name = excluded.station_name,
          short_name = excluded.short_name,
          total_docks = excluded.total_docks,
          docks_in_service = excluded.docks_in_service,
          status = excluded.status,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          is_electric = excluded.is_electric,
          state_hash = excluded.state_hash,
          last_seen_at = excluded.last_seen_at
      `);

      for (const station of incoming) {
        const existing = existingById.get(station.id);
        const firstSeenAt = existing?.first_seen_at ?? observedAt;
        const stateHash = stationStateHash(station);

        upsert.run({
          ...station,
          isElectric: station.isElectric ? 1 : 0,
          stateHash,
          firstSeenAt,
          lastSeenAt: observedAt,
        });

        if (baselineCreated) {
          continue;
        }

        let eventType: StationEventType | undefined;
        if (!existing) {
          discovered += 1;
          eventType = "station.discovered";
        } else if (existing.is_electric === 0 && station.isElectric) {
          electrified += 1;
          eventType = "station.electrified";
        }

        if (
          eventType &&
          this.createEvent(eventType, station, observedAt)
        ) {
          eventsCreated += 1;
        }
      }

      return {
        baselineCreated,
        stationsProcessed: incoming.length,
        discovered,
        electrified,
        eventsCreated,
      };
    })();
  }

  recoverAbandonedDeliveries(
    staleBefore = new Date(Date.now() - 30 * 60 * 1_000).toISOString(),
  ): number {
    const result = this.sqlite
      .prepare(`
        UPDATE deliveries
        SET status = 'retrying',
            locked_at = NULL,
            next_attempt_at = @now,
            last_error = COALESCE(last_error, 'Recovered abandoned delivery')
        WHERE status = 'processing'
          AND locked_at < @staleBefore
      `)
      .run({ now: new Date().toISOString(), staleBefore });

    return result.changes;
  }

  listReadyDeliveries(
    limit: number,
    now = new Date().toISOString(),
  ): PendingDelivery[] {
    const rows = this.sqlite
      .prepare(`
        SELECT
          deliveries.id,
          deliveries.event_id,
          deliveries.record_key,
          deliveries.announcement_style,
          deliveries.status,
          deliveries.attempts,
          events.payload
        FROM deliveries
        JOIN events ON events.id = deliveries.event_id
        WHERE deliveries.status IN ('pending', 'retrying')
          AND deliveries.next_attempt_at <= ?
        ORDER BY deliveries.rowid
        LIMIT ?
      `)
      .all(now, limit) as DeliveryRow[];

    return rows.map(deliveryFromRow);
  }

  claimDelivery(deliveryId: string): boolean {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(`
        UPDATE deliveries
        SET status = 'processing',
            locked_at = @now,
            last_attempt_at = @now,
            attempts = attempts + 1
        WHERE id = @deliveryId
          AND status IN ('pending', 'retrying')
      `)
      .run({ deliveryId, now });

    return result.changes === 1;
  }

  markDelivered(
    deliveryId: string,
    result: { uri: string; cid: string },
  ): void {
    const now = new Date().toISOString();
    const update = this.sqlite
      .prepare(`
        UPDATE deliveries
        SET status = 'delivered',
            locked_at = NULL,
            last_error = NULL,
            post_uri = @uri,
            post_cid = @cid,
            delivered_at = @now
        WHERE id = @deliveryId
          AND status = 'processing'
      `)
      .run({ deliveryId, uri: result.uri, cid: result.cid, now });

    if (update.changes !== 1) {
      throw new Error(`Could not mark delivery ${deliveryId} delivered`);
    }
  }

  markDeliveryFailed(deliveryId: string, error: unknown): void {
    const row = this.sqlite
      .prepare("SELECT attempts FROM deliveries WHERE id = ?")
      .get(deliveryId) as { attempts: number } | undefined;
    if (!row) {
      throw new Error(`Unknown delivery ${deliveryId}`);
    }

    const delayMinutes = Math.min(2 ** Math.max(row.attempts - 1, 0), 12 * 60);
    const nextAttemptAt = new Date(
      Date.now() + delayMinutes * 60 * 1_000,
    ).toISOString();
    const message =
      error instanceof Error ? error.message : String(error);

    this.sqlite
      .prepare(`
        UPDATE deliveries
        SET status = 'retrying',
            locked_at = NULL,
            last_error = @message,
            next_attempt_at = @nextAttemptAt
        WHERE id = @deliveryId
          AND status = 'processing'
      `)
      .run({
        deliveryId,
        message: message.slice(0, 2_000),
        nextAttemptAt,
      });
  }

  getDeliveryCounts(): DeliveryCounts {
    const counts: DeliveryCounts = {
      pending: 0,
      processing: 0,
      retrying: 0,
      delivered: 0,
    };

    const rows = this.sqlite
      .prepare(`
        SELECT status, COUNT(*) AS count
        FROM deliveries
        GROUP BY status
      `)
      .all() as Array<{ status: DeliveryStatus; count: number }>;

    for (const row of rows) {
      counts[row.status] = row.count;
    }

    return counts;
  }

  startRun(startedAt = new Date().toISOString()): string {
    const id = randomUUID();
    this.sqlite
      .prepare(`
        INSERT INTO runs (id, started_at, status)
        VALUES (?, ?, 'running')
      `)
      .run(id, startedAt);
    return id;
  }

  finishRun(
    runId: string,
    values: {
      stationsFetched: number;
      eventsCreated: number;
      deliveriesCompleted: number;
    },
  ): void {
    this.sqlite
      .prepare(`
        UPDATE runs
        SET status = 'succeeded',
            finished_at = @finishedAt,
            stations_fetched = @stationsFetched,
            events_created = @eventsCreated,
            deliveries_completed = @deliveriesCompleted
        WHERE id = @runId AND status = 'running'
      `)
      .run({
        runId,
        finishedAt: new Date().toISOString(),
        stationsFetched: values.stationsFetched,
        eventsCreated: values.eventsCreated,
        deliveriesCompleted: values.deliveriesCompleted,
      });
  }

  failRun(runId: string, error: unknown): void {
    const message =
      error instanceof Error ? error.message : String(error);
    this.sqlite
      .prepare(`
        UPDATE runs
        SET status = 'failed',
            finished_at = @finishedAt,
            error = @message
        WHERE id = @runId AND status = 'running'
      `)
      .run({
        runId,
        finishedAt: new Date().toISOString(),
        message: message.slice(0, 2_000),
      });
  }

  private createEvent(
    type: StationEventType,
    station: StationSnapshot,
    observedAt: string,
  ): boolean {
    const eventId = randomUUID();
    const dedupeKey = `${type}:${station.id}`;
    const payload: StationEventPayload = {
      type,
      station,
      observedAt,
    };
    const eventInsert = this.sqlite
      .prepare(`
        INSERT OR IGNORE INTO events (
          id, dedupe_key, type, station_id, payload, created_at
        ) VALUES (
          @id, @dedupeKey, @type, @stationId, @payload, @createdAt
        )
      `)
      .run({
        id: eventId,
        dedupeKey,
        type,
        stationId: station.id,
        payload: JSON.stringify(payload),
        createdAt: observedAt,
      });

    if (eventInsert.changes !== 1) {
      return false;
    }

    this.sqlite
      .prepare(`
        INSERT INTO deliveries (
          id, event_id, record_key, announcement_style, status,
          next_attempt_at, created_at
        ) VALUES (
          @id, @eventId, @recordKey, @announcementStyle, 'pending',
          @createdAt, @createdAt
        )
      `)
      .run({
        id: randomUUID(),
        eventId,
        recordKey: TID.nextStr(),
        announcementStyle: this.nextAnnouncementStyle(),
        createdAt: observedAt,
      });

    return true;
  }

  private nextAnnouncementStyle(): AnnouncementStyle {
    const previous = this.sqlite
      .prepare(`
        SELECT announcement_style
        FROM deliveries
        ORDER BY rowid DESC
        LIMIT 1
      `)
      .get() as { announcement_style: AnnouncementStyle } | undefined;

    return previous?.announcement_style === "civic" ? "nightline" : "civic";
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      (
        this.sqlite
          .prepare("SELECT version FROM schema_migrations")
          .all() as Array<{ version: number }>
      ).map((row) => row.version),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }

      this.sqlite.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.sqlite
          .prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, ?)
          `)
          .run(migration.version, migration.name, new Date().toISOString());
      })();
    }

    const migrationCount = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as CountRow;
    if (migrationCount.count !== migrations.length) {
      throw new Error("Database migration state is inconsistent");
    }
  }
}

function stationFromRow(row: StationRow): StationSnapshot {
  return {
    id: row.id,
    stationName: row.station_name,
    shortName: row.short_name,
    totalDocks: row.total_docks,
    docksInService: row.docks_in_service,
    status: row.status,
    latitude: row.latitude,
    longitude: row.longitude,
    isElectric: row.is_electric === 1,
  };
}

function deliveryFromRow(row: DeliveryRow): PendingDelivery {
  return {
    id: row.id,
    eventId: row.event_id,
    recordKey: row.record_key,
    announcementStyle: row.announcement_style,
    status: row.status,
    attempts: row.attempts,
    payload: JSON.parse(row.payload) as StationEventPayload,
  };
}
