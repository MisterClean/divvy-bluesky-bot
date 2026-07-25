import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BotDatabase } from "../src/db/database.js";
import { importLegacyDatabase } from "../src/legacy/importer.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "divvy-legacy-import-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("importLegacyDatabase", () => {
  it("imports a production-shaped database as a silent baseline", () => {
    const directory = makeTemporaryDirectory();
    const legacyPath = path.join(directory, "legacy.db");
    const targetPath = path.join(directory, "target.db");
    const legacy = new BetterSqlite3(legacyPath);
    legacy.exec(`
      CREATE TABLE stations (
        id VARCHAR PRIMARY KEY,
        station_name VARCHAR,
        short_name VARCHAR,
        total_docks INTEGER,
        docks_in_service INTEGER,
        status VARCHAR,
        latitude FLOAT,
        longitude FLOAT,
        is_electric BOOLEAN,
        last_updated DATETIME
      );
    `);
    const insert = legacy.prepare(`
      INSERT INTO stations (
        id, station_name, short_name, total_docks, docks_in_service,
        status, latitude, longitude, is_electric, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "legacy-1",
      "State St & Lake St",
      null,
      19,
      19,
      "In Service",
      41.8858,
      -87.6278,
      0,
      "2026-07-25 18:00:00",
    );
    insert.run(
      "legacy-2",
      "Charging Station*",
      "CHI-CHARGING",
      12,
      12,
      "In Service",
      41.9,
      -87.65,
      1,
      "2026-07-25 18:00:00",
    );
    legacy.close();

    const target = new BotDatabase(targetPath);
    try {
      const summary = importLegacyDatabase(target, legacyPath);
      expect(summary.baselineCreated).toBe(true);
      expect(summary.stationsProcessed).toBe(2);
      expect(summary.eventsCreated).toBe(0);
      expect(target.getStationCount()).toBe(2);
      expect(target.getStation("legacy-1")?.shortName).toBe("");
      expect(target.getStation("legacy-2")?.isElectric).toBe(true);
      expect(target.getDeliveryCounts().pending).toBe(0);
    } finally {
      target.close();
    }
  });

  it("refuses to import over an initialized station baseline", () => {
    const directory = makeTemporaryDirectory();
    const legacyPath = path.join(directory, "legacy.db");
    const targetPath = path.join(directory, "target.db");
    const legacy = new BetterSqlite3(legacyPath);
    legacy.exec(`
      CREATE TABLE stations (
        id VARCHAR PRIMARY KEY,
        station_name VARCHAR,
        short_name VARCHAR,
        total_docks INTEGER,
        docks_in_service INTEGER,
        status VARCHAR,
        latitude FLOAT,
        longitude FLOAT,
        is_electric BOOLEAN,
        last_updated DATETIME
      );
      INSERT INTO stations VALUES (
        'legacy-1', 'Station', '', 1, 1, 'In Service',
        41.9, -87.6, 0, '2026-07-25 18:00:00'
      );
    `);
    legacy.close();

    const target = new BotDatabase(targetPath);
    try {
      target.reconcileStations([
        {
          id: "existing",
          stationName: "Existing",
          shortName: "",
          totalDocks: 1,
          docksInService: 1,
          status: "In Service",
          latitude: 41.9,
          longitude: -87.6,
          isElectric: false,
        },
      ]);
      expect(() => importLegacyDatabase(target, legacyPath)).toThrow(
        "target database must be empty",
      );
    } finally {
      target.close();
    }
  });
});
