import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotDatabase } from "../src/db/database.js";
import { station } from "./fixtures.js";

const temporaryDirectories: string[] = [];

function createDatabase(): BotDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "divvy-bot-test-"));
  temporaryDirectories.push(directory);
  return new BotDatabase(path.join(directory, "bot.sqlite3"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("BotDatabase reconciliation", () => {
  it("creates a silent baseline on first run", () => {
    const database = createDatabase();
    try {
      const result = database.reconcileStations([station()]);
      expect(result.baselineCreated).toBe(true);
      expect(result.eventsCreated).toBe(0);
      expect(database.getDeliveryCounts().pending).toBe(0);
    } finally {
      database.close();
    }
  });

  it("queues a new station exactly once", () => {
    const database = createDatabase();
    try {
      database.reconcileStations([station()]);
      const added = station({ id: "station-2", stationName: "New Station" });

      const first = database.reconcileStations([station(), added]);
      const second = database.reconcileStations([station(), added]);

      expect(first.discovered).toBe(1);
      expect(first.eventsCreated).toBe(1);
      expect(second.eventsCreated).toBe(0);
      expect(database.getDeliveryCounts().pending).toBe(1);
    } finally {
      database.close();
    }
  });

  it("queues an electrification transition once and commits the new state", () => {
    const database = createDatabase();
    try {
      database.reconcileStations([station()]);
      const electric = station({
        stationName: "State St & Lake St*",
        isElectric: true,
      });

      const first = database.reconcileStations([electric]);
      const second = database.reconcileStations([electric]);

      expect(first.electrified).toBe(1);
      expect(first.eventsCreated).toBe(1);
      expect(second.electrified).toBe(0);
      expect(database.getStation(electric.id)?.isElectric).toBe(true);
    } finally {
      database.close();
    }
  });

  it("moves claimed deliveries to retrying after a failed attempt", () => {
    const database = createDatabase();
    try {
      database.reconcileStations([station()]);
      database.reconcileStations([
        station(),
        station({ id: "station-2", stationName: "New Station" }),
      ]);
      const delivery = database.listReadyDeliveries(1)[0];
      expect(delivery).toBeDefined();
      expect(database.claimDelivery(delivery!.id)).toBe(true);

      database.markDeliveryFailed(delivery!.id, new Error("temporary"));

      expect(database.getDeliveryCounts().retrying).toBe(1);
      expect(database.getDeliveryCounts().processing).toBe(0);
    } finally {
      database.close();
    }
  });
});
