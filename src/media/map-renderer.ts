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
const municipalFontDataUrl = `data:font/ttf;base64,${readFileSync(
  resolve(process.cwd(), "assets/fonts/BigShouldersText-Variable.ttf"),
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
      await page.setContent(
        mapDocument(divvyLogoDataUrl, municipalFontDataUrl),
        {
          waitUntil: "domcontentloaded",
        },
      );
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
          const statusElement =
            document.querySelector<HTMLElement>("[data-status]");
          if (
            !title ||
            !details ||
            !electricDetails ||
            !eyebrowElement ||
            !statusElement
          ) {
            throw new Error("Map card elements are missing");
          }

          eyebrowElement.textContent = eyebrow;
          const isElectrified = eyebrow.toLowerCase().includes("electrified");
          statusElement.textContent = isElectrified ? "CHARGED" : "NEW";
          statusElement.classList.toggle("long", isElectrified);
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
          await document.fonts.ready;
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

function mapDocument(logoDataUrl: string, fontDataUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      @font-face {
        font-family: "Big Shoulders Text";
        font-style: normal;
        font-weight: 100 900;
        src: url("${fontDataUrl}") format("truetype");
      }
      * { box-sizing: border-box; }
      html, body, #map { height: 100%; width: 100%; margin: 0; }
      body {
        overflow: hidden;
        background: #020306;
        color: #ffffff;
        font-family: "Big Shoulders Text", "Arial Narrow", sans-serif;
      }
      #map {
        filter: saturate(0.58) contrast(1.35) brightness(0.58);
      }
      .map-vignette {
        position: absolute;
        z-index: 3;
        inset: 0;
        background:
          radial-gradient(circle at 50% 48%, transparent 0 9%, rgba(2, 3, 6, 0.1) 28%, rgba(2, 3, 6, 0.46) 72%),
          linear-gradient(180deg, rgba(2, 3, 6, 0.46) 0%, transparent 25%),
          linear-gradient(180deg, transparent 31%, rgba(2, 3, 6, 0.18) 48%, rgba(2, 3, 6, 0.94) 69%, #020306 84%);
        pointer-events: none;
      }
      .focus-ring {
        position: absolute;
        z-index: 4;
        top: 50%;
        left: 50%;
        width: 118px;
        height: 118px;
        border: 2px solid rgba(81, 194, 240, 0.8);
        border-radius: 50%;
        box-shadow: 0 0 0 16px rgba(81, 194, 240, 0.12), 0 0 58px rgba(81, 194, 240, 0.34);
        transform: translate(-50%, -50%);
      }
      .brand {
        position: absolute;
        z-index: 5;
        top: 48px;
        left: 48px;
        width: 172px;
      }
      .brand img {
        display: block;
        width: 100%;
        height: auto;
        filter: brightness(0) invert(1);
      }
      .station-card {
        position: absolute;
        z-index: 5;
        right: 42px;
        bottom: 42px;
        left: 42px;
        text-align: center;
      }
      .announcement-label {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        margin: 0 0 2px;
        padding: 5px 17px 3px;
        border: 1px solid rgba(81, 194, 240, 0.74);
        border-radius: 999px;
        color: #51c2f0;
        font-size: 27px;
        font-weight: 800;
        letter-spacing: 0.13em;
        line-height: 1;
        text-transform: uppercase;
      }
      .status {
        margin: -9px 0 8px;
        color: #ffffff;
        font-size: 300px;
        font-weight: 900;
        letter-spacing: -0.055em;
        line-height: 0.84;
        text-transform: uppercase;
      }
      .status.long {
        font-size: 214px;
        letter-spacing: -0.04em;
      }
      h1 {
        margin: 0;
        color: #ffffff;
        font-size: 73px;
        font-weight: 800;
        line-height: 0.92;
        letter-spacing: -0.025em;
        text-transform: uppercase;
      }
      h1.long {
        font-size: 61px;
      }
      h1.very-long {
        font-size: 50px;
      }
      .details-row {
        display: flex;
        justify-content: center;
        gap: 28px;
        margin-top: 17px;
      }
      .details {
        display: inline-flex;
        align-items: center;
        color: #d9dde4;
        font-size: 29px;
        font-weight: 700;
        letter-spacing: 0.09em;
        text-transform: uppercase;
      }
      .details + .details::before {
        margin-right: 28px;
        color: #51c2f0;
        content: "•";
      }
      .details.electric {
        color: #d9dde4;
      }
      .details[hidden] {
        display: none;
      }
      .attribution {
        position: absolute;
        z-index: 5;
        right: 18px;
        bottom: 12px;
        color: rgba(255, 255, 255, 0.42);
        font: 500 11px/1 Roboto, Arial, sans-serif;
        line-height: 1;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="map-vignette"></div>
    <div class="focus-ring" aria-hidden="true"></div>
    <div class="brand" aria-label="Divvy">
      <img src="${logoDataUrl}" alt="Divvy">
    </div>
    <section class="station-card" aria-label="Divvy station details">
      <p class="announcement-label" data-eyebrow></p>
      <p class="status" data-status></p>
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
