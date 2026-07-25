import type { AppConfig } from "./config.js";
import { BotDatabase } from "./db/database.js";
import { errorContext, logger } from "./logging.js";
import { ProtomapsRenderer } from "./media/map-renderer.js";
import { GoogleStreetViewProvider } from "./media/streetview.js";
import {
  BlueskyPublisher,
  type DeliveryPublisher,
} from "./publishing/bluesky-publisher.js";
import { DivvySource } from "./source/divvy-source.js";

export interface RunSummary {
  stationsFetched: number;
  eventsCreated: number;
  deliveriesCompleted: number;
  deliveryFailures: number;
}

export async function runBot(config: AppConfig): Promise<RunSummary> {
  const database = new BotDatabase(config.databasePath);
  const runId = database.startRun();
  let publisher: DeliveryPublisher | undefined;

  try {
    const recovered = database.recoverAbandonedDeliveries();
    if (recovered > 0) {
      logger.warn("Recovered abandoned deliveries", { recovered });
    }

    const stations = await DivvySource.fromConfig(config).fetchStations();
    const reconciliation = database.reconcileStations(stations);
    logger.info("Reconciled station snapshot", { ...reconciliation });

    let deliveriesCompleted = 0;
    let deliveryFailures = 0;

    if (config.publishEnabled) {
      const mapRenderer = ProtomapsRenderer.fromConfig(config);
      const streetView = config.streetViewEnabled
        ? GoogleStreetViewProvider.fromConfig(config)
        : undefined;
      publisher = BlueskyPublisher.fromConfig(
        config,
        mapRenderer,
        streetView,
      );
      const deliveries = database.listReadyDeliveries(config.postLimit);

      for (const delivery of deliveries) {
        if (!database.claimDelivery(delivery.id)) {
          logger.warn("Skipped delivery claimed by another worker", {
            deliveryId: delivery.id,
          });
          continue;
        }

        try {
          const result = await publisher.publish(delivery);
          database.markDelivered(delivery.id, result);
          deliveriesCompleted += 1;
          logger.info("Published station event", {
            eventType: delivery.payload.type,
            stationId: delivery.payload.station.id,
            postUri: result.uri,
          });
        } catch (error) {
          database.markDeliveryFailed(delivery.id, error);
          deliveryFailures += 1;
          logger.error("Station event delivery failed and was requeued", {
            deliveryId: delivery.id,
            stationId: delivery.payload.station.id,
            ...errorContext(error),
          });
        }
      }
    } else {
      logger.info("Publishing disabled; queued deliveries were left pending", {
        deliveryCounts: database.getDeliveryCounts(),
      });
    }

    const summary: RunSummary = {
      stationsFetched: stations.length,
      eventsCreated: reconciliation.eventsCreated,
      deliveriesCompleted,
      deliveryFailures,
    };
    if (deliveryFailures > 0) {
      throw new Error(
        `${deliveryFailures} station deliver${
          deliveryFailures === 1 ? "y" : "ies"
        } failed and were requeued`,
      );
    }
    database.finishRun(runId, summary);
    return summary;
  } catch (error) {
    database.failRun(runId, error);
    throw error;
  } finally {
    try {
      await publisher?.close();
    } finally {
      database.close();
    }
  }
}
