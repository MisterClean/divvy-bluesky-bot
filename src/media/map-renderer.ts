import { createRequire } from "node:module";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import sharp from "sharp";
import type { AppConfig } from "../config.js";
import type { StationSnapshot } from "../domain/station.js";
import { assertImageSize, MAX_IMAGE_BYTES, type PostImage } from "./image.js";

const require = createRequire(import.meta.url);
const mapLibreScriptPath = require.resolve("maplibre-gl/dist/maplibre-gl.js");
const mapLibreStylePath = require.resolve("maplibre-gl/dist/maplibre-gl.css");

export interface StationMapRenderer {
  render(
    station: StationSnapshot,
    options?: { eyebrow: string },
  ): Promise<PostImage>;
  close(): Promise<void>;
}

export interface MapRendererOptions {
  styleUrl: string;
  width: number;
  height: number;
  zoom: number;
}

export class ProtomapsRenderer implements StationMapRenderer {
  private browser: Browser | undefined;

  constructor(private readonly options: MapRendererOptions) {}

  static fromConfig(config: AppConfig): ProtomapsRenderer {
    if (!config.protomapsStyleUrl) {
      throw new Error(
        "PROTOMAPS_KEY or PROTOMAPS_STYLE_URL is required to render maps",
      );
    }

    return new ProtomapsRenderer({
      styleUrl: config.protomapsStyleUrl,
      width: config.mapWidth,
      height: config.mapHeight,
      zoom: config.mapZoom,
    });
  }

  async render(
    station: StationSnapshot,
    renderOptions: { eyebrow: string } = { eyebrow: "Divvy station" },
  ): Promise<PostImage> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      viewport: {
        width: this.options.width,
        height: this.options.height,
      },
      deviceScaleFactor: 1,
    });

    try {
      await page.setContent(mapDocument(), { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ path: mapLibreStylePath });
      await page.addScriptTag({ path: mapLibreScriptPath });
      await page.evaluate(
        async ({ station, styleUrl, zoom, eyebrow }) => {
          const globalWindow = window as typeof window & {
            maplibregl: {
              Map: new (options: Record<string, unknown>) => {
                on: (
                  event: string,
                  listener: (event?: { error?: Error }) => void,
                ) => void;
                addSource: (id: string, source: unknown) => void;
                addLayer: (layer: unknown) => void;
              };
            };
          };
          const title = document.querySelector<HTMLElement>("[data-title]");
          const details =
            document.querySelector<HTMLElement>("[data-details]");
          const eyebrowElement =
            document.querySelector<HTMLElement>("[data-eyebrow]");
          if (!title || !details || !eyebrowElement) {
            throw new Error("Map card elements are missing");
          }

          eyebrowElement.textContent = eyebrow;
          title.textContent = station.stationName.replace(/\*$/, "");
          details.textContent = `${station.totalDocks} docks${
            station.isElectric ? " · Charging station" : ""
          }`;

          await new Promise<void>((resolve, reject) => {
            const map = new globalWindow.maplibregl.Map({
              container: "map",
              style: styleUrl,
              center: [station.longitude, station.latitude],
              zoom,
              attributionControl: false,
              interactive: false,
              fadeDuration: 0,
              preserveDrawingBuffer: true,
            });
            let loaded = false;

            const timeout = window.setTimeout(() => {
              reject(new Error("Timed out waiting for Protomaps to render"));
            }, 30_000);

            map.on("error", (event) => {
              if (event?.error) {
                window.clearTimeout(timeout);
                reject(event.error);
              }
            });

            map.on("load", () => {
              loaded = true;
              map.addSource("station", {
                type: "geojson",
                data: {
                  type: "Feature",
                  properties: {},
                  geometry: {
                    type: "Point",
                    coordinates: [station.longitude, station.latitude],
                  },
                },
              });
              map.addLayer({
                id: "station-shadow",
                type: "circle",
                source: "station",
                paint: {
                  "circle-radius": 30,
                  "circle-color": "#0f172a",
                  "circle-opacity": 0.24,
                  "circle-blur": 0.45,
                },
              });
              map.addLayer({
                id: "station-marker",
                type: "circle",
                source: "station",
                paint: {
                  "circle-radius": 18,
                  "circle-color": station.isElectric ? "#e11d48" : "#2563eb",
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-width": 6,
                },
              });
            });

            map.on("idle", () => {
              if (!loaded) {
                return;
              }
              window.clearTimeout(timeout);
              resolve();
            });
          });
        },
        {
          station,
          styleUrl: this.options.styleUrl,
          zoom: this.options.zoom,
          eyebrow: renderOptions.eyebrow,
        },
      );

      const png = await page.screenshot({
        type: "png",
        animations: "disabled",
      });
      const bytes = await compressMap(png);
      const image: PostImage = {
        bytes,
        mimeType: "image/jpeg",
        alt: `Map centered on ${station.stationName.replace(/\*$/, "")}, a Divvy station at ${station.latitude.toFixed(5)}, ${station.longitude.toFixed(5)}, showing nearby streets.`,
        width: this.options.width,
        height: this.options.height,
      };
      assertImageSize(image);
      return image;
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
  }

  private async getBrowser(): Promise<Browser> {
    this.browser ??= await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"],
    });
    return this.browser;
  }
}

async function compressMap(png: Buffer): Promise<Buffer> {
  for (const quality of [88, 82, 76, 70]) {
    const jpeg = await sharp(png)
      .flatten({ background: "#f8fafc" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (jpeg.length <= MAX_IMAGE_BYTES) {
      return jpeg;
    }
  }

  throw new Error("Could not compress map below the Bluesky image limit");
}

function mapDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body, #map { height: 100%; width: 100%; margin: 0; }
      body {
        overflow: hidden;
        background: #f8fafc;
        color: #0f172a;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .station-card {
        position: absolute;
        z-index: 5;
        top: 32px;
        left: 32px;
        right: 32px;
        padding: 22px 26px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 16px 42px rgba(15, 23, 42, 0.16);
        backdrop-filter: blur(10px);
      }
      .eyebrow {
        margin: 0 0 6px;
        color: #2563eb;
        font-size: 22px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 40px;
        line-height: 1.08;
        letter-spacing: -0.025em;
      }
      .details {
        margin-top: 9px;
        color: #475569;
        font-size: 24px;
        font-weight: 650;
      }
      .attribution {
        position: absolute;
        z-index: 5;
        right: 18px;
        bottom: 14px;
        padding: 6px 9px;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.88);
        color: #475569;
        font-size: 14px;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <section class="station-card" aria-label="Divvy station details">
      <p class="eyebrow" data-eyebrow></p>
      <h1 data-title></h1>
      <div class="details" data-details></div>
    </section>
    <div class="attribution">© Protomaps · © OpenStreetMap contributors</div>
  </body>
</html>`;
}
