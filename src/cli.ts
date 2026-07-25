#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { runBot } from "./app.js";
import { loadConfig } from "./config.js";
import { BotDatabase } from "./db/database.js";
import { importLegacyDatabase } from "./legacy/importer.js";
import { errorContext, logger } from "./logging.js";
import { ProtomapsRenderer } from "./media/map-renderer.js";

async function main(): Promise<void> {
  const [command = "run", ...arguments_] = process.argv.slice(2);
  const config = loadConfig();

  switch (command) {
    case "run": {
      const summary = await runBot(config);
      logger.info("Bot run completed", { ...summary });
      return;
    }
    case "status": {
      const database = new BotDatabase(config.databasePath);
      try {
        logger.info("Bot database status", {
          databasePath: config.databasePath,
          stationCount: database.getStationCount(),
          deliveryCounts: database.getDeliveryCounts(),
          publishEnabled: config.publishEnabled,
        });
      } finally {
        database.close();
      }
      return;
    }
    case "render": {
      const stationId = arguments_[0];
      if (!stationId) {
        throw new Error("Usage: npm run dev -- render <station-id> [output]");
      }
      const database = new BotDatabase(config.databasePath);
      const renderer = ProtomapsRenderer.fromConfig(config);
      try {
        const station = database.getStation(stationId);
        if (!station) {
          throw new Error(`Station ${stationId} was not found`);
        }
        const image = await renderer.render(station);
        const outputPath = path.resolve(
          arguments_[1] ??
            path.join(
              config.outputDirectory,
              `${station.id.replaceAll("/", "_")}.jpg`,
            ),
        );
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, image.bytes);
        logger.info("Rendered station map", {
          stationId,
          outputPath,
          bytes: image.bytes.length,
        });
      } finally {
        await renderer.close();
        database.close();
      }
      return;
    }
    case "import-legacy": {
      const legacyPath = arguments_[0];
      if (!legacyPath) {
        throw new Error(
          "Usage: npm run dev -- import-legacy <legacy-database-path>",
        );
      }
      const database = new BotDatabase(config.databasePath);
      try {
        const summary = importLegacyDatabase(database, legacyPath);
        logger.info("Imported legacy station baseline", {
          legacyPath: path.resolve(legacyPath),
          ...summary,
        });
      } finally {
        database.close();
      }
      return;
    }
    default:
      throw new Error(
        `Unknown command ${command}. Expected run, status, render, or import-legacy.`,
      );
  }
}

main().catch((error: unknown) => {
  logger.error("Command failed", errorContext(error));
  process.exitCode = 1;
});
