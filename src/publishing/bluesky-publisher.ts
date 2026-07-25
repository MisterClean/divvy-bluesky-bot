import { AtpAgent } from "@atproto/api";
import type { BlobRef } from "@atproto/lexicon";
import type { AppConfig } from "../config.js";
import type { PendingDelivery } from "../db/database.js";
import { errorContext, logger } from "../logging.js";
import type { PostImage } from "../media/image.js";
import type { StationMapRenderer } from "../media/map-renderer.js";
import type { StreetViewProvider } from "../media/streetview.js";
import { createPostText } from "./post-content.js";

export interface PublishResult {
  uri: string;
  cid: string;
}

export interface DeliveryPublisher {
  publish(delivery: PendingDelivery): Promise<PublishResult>;
  close(): Promise<void>;
}

export interface BlueskyPublisherOptions {
  serviceUrl: string;
  identifier: string;
  appPassword: string;
}

export class BlueskyPublisher implements DeliveryPublisher {
  private readonly agent: AtpAgent;
  private authenticated = false;

  constructor(
    private readonly options: BlueskyPublisherOptions,
    private readonly mapRenderer: StationMapRenderer,
    private readonly streetView?: StreetViewProvider,
  ) {
    this.agent = new AtpAgent({ service: options.serviceUrl });
  }

  static fromConfig(
    config: AppConfig,
    mapRenderer: StationMapRenderer,
    streetView?: StreetViewProvider,
  ): BlueskyPublisher {
    if (!config.blueskyIdentifier || !config.blueskyAppPassword) {
      throw new Error(
        "Bluesky credentials are required to construct the publisher",
      );
    }

    return new BlueskyPublisher(
      {
        serviceUrl: config.blueskyServiceUrl,
        identifier: config.blueskyIdentifier,
        appPassword: config.blueskyAppPassword,
      },
      mapRenderer,
      streetView,
    );
  }

  async publish(delivery: PendingDelivery): Promise<PublishResult> {
    await this.authenticate();
    const station = delivery.payload.station;
    const images = [
      await this.mapRenderer.render(station, {
        eyebrow:
          delivery.payload.type === "station.electrified"
            ? "Divvy station electrified"
            : "New Divvy station",
        style: delivery.announcementStyle,
      }),
    ];

    if (this.streetView) {
      try {
        images.push(await this.streetView.fetch(station));
      } catch (error) {
        logger.warn("Street View unavailable; publishing map only", {
          stationId: station.id,
          ...errorContext(error),
        });
      }
    }

    const uploadedImages = await Promise.all(
      images.map(async (image) => ({
        alt: image.alt,
        image: await this.upload(image),
        aspectRatio: {
          width: image.width,
          height: image.height,
        },
      })),
    );
    const record = {
      $type: "app.bsky.feed.post",
      text: createPostText(delivery.payload),
      langs: ["en"],
      embed: {
        $type: "app.bsky.embed.images",
        images: uploadedImages,
      },
      createdAt: new Date().toISOString(),
    };
    const repo = this.agent.assertDid;

    try {
      const response = await this.agent.com.atproto.repo.createRecord({
        repo,
        collection: "app.bsky.feed.post",
        rkey: delivery.recordKey,
        record,
      });
      return {
        uri: response.data.uri,
        cid: response.data.cid,
      };
    } catch (createError) {
      try {
        const existing = await this.agent.com.atproto.repo.getRecord({
          repo,
          collection: "app.bsky.feed.post",
          rkey: delivery.recordKey,
        });
        if (!existing.data.cid) {
          throw createError;
        }
        logger.warn("Reconciled an already-created Bluesky record", {
          deliveryId: delivery.id,
          recordKey: delivery.recordKey,
        });
        return {
          uri: existing.data.uri,
          cid: existing.data.cid,
        };
      } catch {
        throw createError;
      }
    }
  }

  async close(): Promise<void> {
    await this.mapRenderer.close();
  }

  private async authenticate(): Promise<void> {
    if (this.authenticated) {
      return;
    }
    await this.agent.login({
      identifier: this.options.identifier,
      password: this.options.appPassword,
    });
    this.authenticated = true;
  }

  private async upload(image: PostImage): Promise<BlobRef> {
    const response = await this.agent.uploadBlob(image.bytes, {
      encoding: image.mimeType,
    });
    return response.data.blob;
  }
}
