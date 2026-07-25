import type { AtpAgent } from "@atproto/api";
import { describe, expect, it } from "vitest";
import type { PendingDelivery } from "../src/db/database.js";
import type { PostImage } from "../src/media/image.js";
import type { StationMapRenderer } from "../src/media/map-renderer.js";
import type { StreetViewProvider } from "../src/media/streetview.js";
import {
  BlueskyPublisher,
  streetViewRecordKey,
} from "../src/publishing/bluesky-publisher.js";
import { station } from "./fixtures.js";

interface CreatedRecord {
  rkey: string;
  record: {
    text: string;
    embed: {
      images: Array<{ alt: string }>;
    };
    reply?: {
      root: { uri: string; cid: string };
      parent: { uri: string; cid: string };
    };
  };
}

function postImage(alt: string): PostImage {
  return {
    bytes: Buffer.from(alt),
    mimeType: "image/jpeg",
    alt,
    width: 600,
    height: 400,
  };
}

describe("BlueskyPublisher", () => {
  it("puts the announcement in the root and Street View in its first reply", async () => {
    const created: CreatedRecord[] = [];
    const fakeAgent = {
      assertDid: "did:plc:example",
      login: async () => undefined,
      uploadBlob: async (bytes: Uint8Array) => ({
        data: {
          blob: {
            $type: "blob",
            ref: { $link: Buffer.from(bytes).toString() },
            mimeType: "image/jpeg",
            size: bytes.byteLength,
          },
        },
      }),
      com: {
        atproto: {
          repo: {
            createRecord: async (request: CreatedRecord) => {
              created.push(request);
              return {
                data: {
                  uri: `at://did:plc:example/app.bsky.feed.post/${request.rkey}`,
                  cid: `cid-${request.rkey}`,
                },
              };
            },
            getRecord: async () => {
              throw new Error("record does not exist");
            },
          },
        },
      },
    };
    const mapRenderer: StationMapRenderer = {
      render: async () => postImage("announcement alt"),
      close: async () => undefined,
    };
    const streetView: StreetViewProvider = {
      fetch: async () => postImage("street view alt"),
    };
    const publisher = new BlueskyPublisher(
      {
        serviceUrl: "https://bsky.social",
        identifier: "example.test",
        appPassword: "password",
      },
      mapRenderer,
      streetView,
      fakeAgent as unknown as AtpAgent,
    );
    const delivery: PendingDelivery = {
      id: "delivery-1",
      eventId: "event-1",
      recordKey: "3mabc123",
      announcementStyle: "civic",
      status: "pending",
      attempts: 0,
      payload: {
        type: "station.discovered",
        station: station(),
        observedAt: "2026-07-25T12:00:00.000Z",
      },
    };

    const result = await publisher.publish(delivery);

    expect(result).toEqual({
      uri: "at://did:plc:example/app.bsky.feed.post/3mabc123",
      cid: "cid-3mabc123",
    });
    expect(created).toHaveLength(2);
    expect(created[0]?.rkey).toBe(delivery.recordKey);
    expect(created[0]?.record.embed.images).toEqual([
      {
        alt: "announcement alt",
        image: expect.anything(),
        aspectRatio: {
          width: 600,
          height: 400,
        },
      },
    ]);
    expect(created[0]?.record.reply).toBeUndefined();

    const replyRecordKey = streetViewRecordKey(delivery.recordKey);
    expect(created[1]?.rkey).toBe(replyRecordKey);
    expect(created[1]?.record.text).toBe(
      "📸 Street view of State St & Lake St",
    );
    expect(created[1]?.record.embed.images).toEqual([
      {
        alt: "street view alt",
        image: expect.anything(),
        aspectRatio: {
          width: 600,
          height: 400,
        },
      },
    ]);
    expect(created[1]?.record.reply).toEqual({
      root: result,
      parent: result,
    });
  });
});
