import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import sharp from "sharp";
import type { AppConfig } from "../config.js";
import type { StationSnapshot } from "../domain/station.js";
import { assertImageSize, MAX_IMAGE_BYTES, type PostImage } from "./image.js";

const require = createRequire(import.meta.url);
const mapLibreScriptPath = require.resolve("maplibre-gl/dist/maplibre-gl.js");
const mapLibreStylePath = require.resolve("maplibre-gl/dist/maplibre-gl.css");
const divvyLogoDataUrl = `data:image/svg+xml;base64,${readFileSync(
  resolve(process.cwd(), "assets/divvy-logo.svg"),
).toString("base64")}`;

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
    renderOptions: { eyebrow: string } = { eyebrow: "New Divvy Station" },
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
      await page.setContent(mapDocument(divvyLogoDataUrl), {
        waitUntil: "domcontentloaded",
      });
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
            document.querySelector<HTMLElement>("[data-docks]");
          const electricDetails =
            document.querySelector<HTMLElement>("[data-electric]");
          const eyebrowElement =
            document.querySelector<HTMLElement>("[data-eyebrow]");
          if (!title || !details || !electricDetails || !eyebrowElement) {
            throw new Error("Map card elements are missing");
          }

          eyebrowElement.textContent = eyebrow;
          title.textContent = station.stationName.replace(/\*$/, "");
          details.textContent = `${station.totalDocks} docks`;
          electricDetails.hidden = !station.isElectric;
          const stationNameLength = title.textContent.length;
          if (stationNameLength > 34) {
            title.classList.add("very-long");
          } else if (stationNameLength > 24) {
            title.classList.add("long");
          }

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
                  "circle-radius": 38,
                  "circle-color": "#020617",
                  "circle-opacity": 0.34,
                  "circle-blur": 0.5,
                },
              });
              map.addLayer({
                id: "station-marker",
                type: "circle",
                source: "station",
                paint: {
                  "circle-radius": 22,
                  "circle-color": station.isElectric ? "#fb7185" : "#51c2f0",
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-width": 7,
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

function mapDocument(logoDataUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body, #map { height: 100%; width: 100%; margin: 0; }
      body {
        overflow: hidden;
        background: #e2e8f0;
        color: #ffffff;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #map {
        filter: saturate(0.9) contrast(1.03);
      }
      .map-vignette {
        position: absolute;
        z-index: 3;
        inset: 0;
        background:
          linear-gradient(180deg, rgba(2, 6, 23, 0.18) 0%, transparent 26%),
          linear-gradient(180deg, transparent 35%, rgba(2, 6, 23, 0.26) 58%, rgba(2, 6, 23, 0.98) 100%);
        pointer-events: none;
      }
      .brand {
        position: absolute;
        z-index: 5;
        top: 38px;
        left: 38px;
        display: grid;
        place-items: center;
        width: 244px;
        height: 92px;
        padding: 20px 24px;
        border: 1px solid rgba(255, 255, 255, 0.7);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 14px 32px rgba(2, 6, 23, 0.24);
      }
      .brand img {
        display: block;
        width: 100%;
        height: auto;
      }
      .station-card {
        position: absolute;
        z-index: 5;
        right: 44px;
        bottom: 58px;
        left: 44px;
      }
      .announcement-label {
        position: relative;
        display: inline-flex;
        align-items: center;
        min-height: 42px;
        margin: 0 0 16px;
        padding-left: 20px;
        color: #ffffff;
        font-size: 24px;
        font-weight: 900;
        letter-spacing: 0.085em;
        line-height: 1;
        text-shadow: 0 3px 16px rgba(2, 6, 23, 0.72);
        text-transform: uppercase;
      }
      .announcement-label::before {
        position: absolute;
        left: 0;
        width: 8px;
        height: 38px;
        border-radius: 0 8px 8px 0;
        background: #51c2f0;
        content: "";
      }
      h1 {
        margin: 0;
        max-width: 1080px;
        color: #ffffff;
        font-size: 94px;
        font-weight: 950;
        line-height: 0.92;
        letter-spacing: -0.055em;
        text-shadow: 0 4px 24px rgba(2, 6, 23, 0.5);
        text-transform: uppercase;
      }
      h1.long {
        font-size: 74px;
      }
      h1.very-long {
        font-size: 60px;
      }
      .details-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 24px;
      }
      .details {
        display: inline-flex;
        align-items: center;
        min-height: 52px;
        padding: 10px 18px;
        border-radius: 10px;
        background: #51c2f0;
        color: #07111f;
        font-size: 25px;
        font-weight: 900;
        letter-spacing: 0.025em;
        text-transform: uppercase;
      }
      .details.electric {
        background: #facc15;
      }
      .details[hidden] {
        display: none;
      }
      .attribution {
        position: absolute;
        z-index: 5;
        right: 18px;
        bottom: 14px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        text-shadow: 0 1px 5px rgba(2, 6, 23, 0.9);
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="map-vignette"></div>
    <div class="brand" aria-label="Divvy">
      <img src="${logoDataUrl}" alt="Divvy">
    </div>
    <section class="station-card" aria-label="Divvy station details">
      <p class="announcement-label" data-eyebrow></p>
      <h1 data-title></h1>
      <div class="details-row">
        <div class="details" data-docks></div>
        <div class="details electric" data-electric>⚡️ Electrified Station</div>
      </div>
    </section>
    <div class="attribution">© Protomaps · © OpenStreetMap contributors</div>
  </body>
</html>`;
}
