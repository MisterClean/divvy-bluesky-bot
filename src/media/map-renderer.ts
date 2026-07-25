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
          statusElement.textContent = isElectrified ? "CHARGED" : "OPEN";
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
        background: #071d3a;
        color: #ffffff;
        font-family: "Big Shoulders Text", "Arial Narrow", sans-serif;
      }
      #map {
        filter: grayscale(1) sepia(0.25) hue-rotate(164deg) saturate(2.4) contrast(1.08) brightness(0.75);
      }
      .map-vignette {
        position: absolute;
        z-index: 3;
        inset: 0;
        background:
          linear-gradient(90deg, rgba(5, 26, 55, 0.36), rgba(5, 26, 55, 0.08) 60%, rgba(5, 26, 55, 0.42)),
          linear-gradient(180deg, rgba(5, 26, 55, 0.28) 0%, transparent 32%),
          linear-gradient(180deg, transparent 40%, rgba(5, 26, 55, 0.2) 56%, rgba(5, 26, 55, 0.92) 75%, #051a37 88%);
        pointer-events: none;
      }
      .civic-stripes {
        position: absolute;
        z-index: 4;
        right: 0;
        bottom: 0;
        left: 0;
        height: 18px;
        border-top: 6px solid #51c2f0;
        background: #e4002b;
      }
      .civic-stars {
        position: absolute;
        z-index: 5;
        top: 48px;
        right: 48px;
        display: flex;
        gap: 14px;
        color: #e4002b;
        font-family: Arial, sans-serif;
        font-size: 36px;
        line-height: 1;
      }
      .focus-ring {
        position: absolute;
        z-index: 4;
        top: 49%;
        left: 50%;
        width: 132px;
        height: 132px;
        border: 4px solid rgba(255, 255, 255, 0.92);
        border-radius: 2px;
        box-shadow: 14px 14px 0 rgba(228, 0, 43, 0.88);
        transform: translate(-50%, -50%);
      }
      .focus-ring::before,
      .focus-ring::after {
        position: absolute;
        background: #51c2f0;
        content: "";
      }
      .focus-ring::before {
        top: 50%;
        right: -34px;
        left: -34px;
        height: 2px;
      }
      .focus-ring::after {
        top: -34px;
        bottom: -34px;
        left: 50%;
        width: 2px;
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
        right: 48px;
        bottom: 55px;
        left: 48px;
        text-align: left;
      }
      .announcement-label {
        margin: 0 0 12px;
        color: #51c2f0;
        font-size: 34px;
        font-weight: 900;
        letter-spacing: 0.17em;
        line-height: 1;
        text-transform: uppercase;
      }
      .announcement-label::before {
        display: inline-block;
        width: 52px;
        height: 9px;
        margin: 0 15px 4px 0;
        background: #e4002b;
        content: "";
      }
      .status {
        margin: -18px 0 -4px;
        color: #ffffff;
        font-size: 270px;
        font-weight: 900;
        letter-spacing: -0.045em;
        line-height: 0.88;
        text-shadow: 10px 10px 0 rgba(7, 29, 58, 0.36);
        text-transform: uppercase;
      }
      .status.long {
        font-size: 205px;
        letter-spacing: -0.04em;
      }
      h1 {
        margin: 0;
        color: #ffffff;
        font-size: 78px;
        font-weight: 800;
        line-height: 0.9;
        letter-spacing: -0.02em;
        text-transform: uppercase;
      }
      h1.long {
        font-size: 64px;
      }
      h1.very-long {
        font-size: 52px;
      }
      .details-row {
        display: flex;
        gap: 12px;
        margin-top: 22px;
      }
      .details {
        display: inline-flex;
        align-items: center;
        min-height: 49px;
        padding: 5px 17px 3px;
        border: 2px solid rgba(255, 255, 255, 0.72);
        color: #ffffff;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .details + .details::before {
        display: none;
      }
      .details.electric {
        border-color: #e4002b;
        background: #e4002b;
        color: #ffffff;
      }
      .details[hidden] {
        display: none;
      }
      .attribution {
        position: absolute;
        z-index: 5;
        right: 18px;
        bottom: 28px;
        color: rgba(255, 255, 255, 0.58);
        font: 500 11px/1 Roboto, Arial, sans-serif;
        line-height: 1;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="map-vignette"></div>
    <div class="civic-stars" aria-hidden="true"><span>✶</span><span>✶</span><span>✶</span><span>✶</span></div>
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
    <div class="civic-stripes" aria-hidden="true"></div>
    <div class="attribution">© Protomaps · © OpenStreetMap contributors</div>
  </body>
</html>`;
}
