import sharp from "sharp";
import type { AppConfig } from "../config.js";
import type { StationSnapshot } from "../domain/station.js";
import {
  assertImageSize,
  createStationImageAlt,
  encodeJpegAtHighestQuality,
  type PostImage,
} from "./image.js";

export interface StreetViewProvider {
  fetch(station: StationSnapshot): Promise<PostImage>;
}

export interface StreetViewOptions {
  apiKey: string;
  timeoutMs: number;
}

export class GoogleStreetViewProvider implements StreetViewProvider {
  constructor(private readonly options: StreetViewOptions) {}

  static fromConfig(config: AppConfig): GoogleStreetViewProvider {
    if (!config.googleMapsApiKey) {
      throw new Error(
        "GOOGLE_MAPS_API_KEY is required when Street View is enabled",
      );
    }
    return new GoogleStreetViewProvider({
      apiKey: config.googleMapsApiKey,
      timeoutMs: config.streetViewTimeoutMs,
    });
  }

  async fetch(station: StationSnapshot): Promise<PostImage> {
    const url = new URL("https://maps.googleapis.com/maps/api/streetview");
    url.searchParams.set("size", "600x400");
    url.searchParams.set("location", `${station.latitude},${station.longitude}`);
    url.searchParams.set("return_error_code", "true");
    url.searchParams.set("key", this.options.apiKey);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Google Street View returned ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`Google Street View returned ${contentType || "non-image"}`);
    }

    const source = Buffer.from(await response.arrayBuffer());
    const bytes = await compressStreetView(source);
    const image: PostImage = {
      bytes,
      mimeType: "image/jpeg",
      alt: createStationImageAlt(
        station,
        `Google Street View imagery near ${station.stationName.replace(/\*$/, "")}, a Divvy station in Chicago.`,
      ),
      width: 600,
      height: 400,
    };
    assertImageSize(image);
    return image;
  }
}

async function compressStreetView(source: Buffer): Promise<Buffer> {
  return encodeJpegAtHighestQuality((quality) =>
    sharp(source)
      .rotate()
      .jpeg({ quality, mozjpeg: true })
      .toBuffer(),
  );
}
