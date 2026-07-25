import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { isElectricStation, type StationSnapshot } from "../domain/station.js";
import { errorContext, logger } from "../logging.js";

const sodaStationSchema = z.object({
  id: z.string().min(1),
  station_name: z.string().min(1),
  short_name: z.string().default(""),
  total_docks: z.coerce.number().int().nonnegative(),
  docks_in_service: z.coerce.number().int().nonnegative(),
  status: z.string().min(1),
  latitude: z.coerce.number().min(41.5).max(42.2),
  longitude: z.coerce.number().min(-88).max(-87.4),
});

const sodaResponseSchema = z.array(sodaStationSchema);

export interface DivvySourceOptions {
  url: string;
  timeoutMs: number;
  maxRetries: number;
  minimumStationCount: number;
}

export class DivvySource {
  constructor(private readonly options: DivvySourceOptions) {}

  static fromConfig(config: AppConfig): DivvySource {
    return new DivvySource({
      url: config.sodaUrl,
      timeoutMs: config.sodaTimeoutMs,
      maxRetries: config.sodaMaxRetries,
      minimumStationCount: config.sodaMinStations,
    });
  }

  async fetchStations(): Promise<StationSnapshot[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await this.fetchOnce();
      } catch (error) {
        lastError = error;
        const isFinalAttempt = attempt === this.options.maxRetries;
        logger.warn("Divvy station fetch failed", {
          attempt: attempt + 1,
          isFinalAttempt,
          ...errorContext(error),
        });

        if (!isFinalAttempt) {
          await delay(2 ** attempt * 1_000);
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Divvy station fetch failed");
  }

  private async fetchOnce(): Promise<StationSnapshot[]> {
    const url = new URL(this.options.url);
    url.searchParams.set("$limit", "50000");
    url.searchParams.set("$order", "id");

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "divvy-bluesky-bot/2.0",
      },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Divvy API returned ${response.status} ${response.statusText}`,
      );
    }

    const raw: unknown = await response.json();
    const records = sodaResponseSchema.parse(raw);

    if (records.length < this.options.minimumStationCount) {
      throw new Error(
        `Divvy API returned ${records.length} stations; expected at least ${this.options.minimumStationCount}`,
      );
    }

    const ids = new Set<string>();
    const stations = records.map((record): StationSnapshot => {
      if (ids.has(record.id)) {
        throw new Error(`Divvy API returned duplicate station ID ${record.id}`);
      }
      ids.add(record.id);

      const stationName = record.station_name.trim();
      const shortName = record.short_name.trim();

      return {
        id: record.id,
        stationName,
        shortName,
        totalDocks: record.total_docks,
        docksInService: record.docks_in_service,
        status: record.status,
        latitude: record.latitude,
        longitude: record.longitude,
        isElectric: isElectricStation(stationName, shortName),
      };
    });

    logger.info("Fetched and validated Divvy stations", {
      stationCount: stations.length,
    });

    return stations;
  }
}
