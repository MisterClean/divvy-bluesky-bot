import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { BotDatabase, ReconciliationSummary } from "../db/database.js";
import type { StationSnapshot } from "../domain/station.js";

interface LegacyStationRow {
  id: string;
  station_name: string;
  short_name: string | null;
  total_docks: number;
  docks_in_service: number;
  status: string;
  latitude: number;
  longitude: number;
  is_electric: number | null;
}

export function importLegacyDatabase(
  target: BotDatabase,
  legacyPath: string,
): ReconciliationSummary {
  if (target.getStationCount() !== 0) {
    throw new Error("The target database must be empty before legacy import");
  }

  const source = new BetterSqlite3(path.resolve(legacyPath), {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const rows = source
      .prepare(`
        SELECT
          id, station_name, short_name, total_docks, docks_in_service,
          status, latitude, longitude, is_electric
        FROM stations
        ORDER BY id
      `)
      .all() as LegacyStationRow[];
    if (rows.length === 0) {
      throw new Error("The legacy database contains no stations");
    }

    const stations = rows.map(
      (row): StationSnapshot => ({
        id: row.id,
        stationName: row.station_name,
        shortName: row.short_name ?? "",
        totalDocks: row.total_docks,
        docksInService: row.docks_in_service,
        status: row.status,
        latitude: row.latitude,
        longitude: row.longitude,
        isElectric: row.is_electric === 1,
      }),
    );

    return target.reconcileStations(stations);
  } finally {
    source.close();
  }
}
