import { AtpAgent } from "@atproto/api";
import type { BlobRef } from "@atproto/lexicon";
import type { AppConfig } from "../config.js";
import type { PendingDelivery } from "../db/database.js";
import { errorContext, logger } from "../logging.js";
import type { PostImage } from "../media/image.js";
import type { StationMapRenderer } from "../media/map-renderer.js";
import type { StreetViewProvider } from "../media/streetview.js";
import {
  createPostText,
  createStreetViewPostText,
} from "./post-content.js";

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
    agent?: AtpAgent,
  ) {
    this.agent = agent ?? new AtpAgent({ service: options.serviceUrl });
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
    const announcement = await this.mapRenderer.render(station, {
      eyebrow:
        delivery.payload.type === "station.electrified"
          ? "Divvy station electrified"
          : "New Divvy station",
      style: delivery.announcementStyle,
    });
    const root = await this.publishImagePost({
      deliveryId: delivery.id,
      recordKey: delivery.recordKey,
      text: createPostText(delivery.payload),
      image: announcement,
    });

    if (this.streetView) {
      let streetViewImage: PostImage;
      try {
        streetViewImage = await this.streetView.fetch(station);
      } catch (error) {
        logger.warn(
          "Street View unavailable; publishing announcement only",
          {
            stationId: station.id,
            ...errorContext(error),
          },
        );
        return root;
      }

      await this.publishImagePost({
        deliveryId: delivery.id,
        recordKey: streetViewRecordKey(delivery.recordKey),
        text: createStreetViewPostText(delivery.payload),
        image: streetViewImage,
        reply: {
          root,
          parent: root,
        },
      });
    }

    return root;
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

  private async publishImagePost(options: {
    deliveryId: string;
    recordKey: string;
    text: string;
    image: PostImage;
    reply?: {
      root: PublishResult;
      parent: PublishResult;
    };
  }): Promise<PublishResult> {
    const uploadedImage = {
      alt: options.image.alt,
      image: await this.upload(options.image),
      aspectRatio: {
        width: options.image.width,
        height: options.image.height,
      },
    };
    const record = {
      $type: "app.bsky.feed.post",
      text: options.text,
      langs: ["en"],
      embed: {
        $type: "app.bsky.embed.images",
        images: [uploadedImage],
      },
      ...(options.reply
        ? {
            reply: {
              root: options.reply.root,
              parent: options.reply.parent,
            },
          }
        : {}),
      createdAt: new Date().toISOString(),
    };
    const repo = this.agent.assertDid;

    try {
      const response = await this.agent.com.atproto.repo.createRecord({
        repo,
        collection: "app.bsky.feed.post",
        rkey: options.recordKey,
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
          rkey: options.recordKey,
        });
        if (!existing.data.cid) {
          throw createError;
        }
        logger.warn("Reconciled an already-created Bluesky record", {
          deliveryId: options.deliveryId,
          recordKey: options.recordKey,
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

  private async upload(image: PostImage): Promise<BlobRef> {
    const response = await this.agent.uploadBlob(image.bytes, {
      encoding: image.mimeType,
    });
    return response.data.blob;
  }
}

export function streetViewRecordKey(rootRecordKey: string): string {
  return `${rootRecordKey}-streetview`;
}
