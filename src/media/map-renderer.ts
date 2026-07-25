import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import type { AppConfig } from "../config.js";
import type {
  AnnouncementStyle,
  StationSnapshot,
} from "../domain/station.js";
import { assertImageSize, MAX_IMAGE_BYTES, type PostImage } from "./image.js";

const require = createRequire(import.meta.url);
const mapLibreScriptPath = require.resolve("maplibre-gl/dist/maplibre-gl.js");
const mapLibreStylePath = require.resolve("maplibre-gl/dist/maplibre-gl.css");
const mapLibreScript = readFileSync(mapLibreScriptPath, "utf8").replaceAll(
  "</script",
  "<\\/script",
);
const mapLibreStyle = readFileSync(mapLibreStylePath, "utf8");
const divvyLogoDataUrl = `data:image/svg+xml;base64,${readFileSync(
  resolve(process.cwd(), "assets/divvy-logo.svg"),
).toString("base64")}`;
const municipalFontDataUrl = `data:font/ttf;base64,${readFileSync(
  resolve(process.cwd(), "assets/fonts/BigShouldersText-Variable.ttf"),
).toString("base64")}`;

export interface StationMapRenderer {
  render(
    station: StationSnapshot,
    options?: { eyebrow: string; style?: AnnouncementStyle },
  ): Promise<PostImage>;
  close(): Promise<void>;
}

export interface MapRendererOptions {
  styleUrl: string;
  width: number;
  height: number;
  pixelRatio: number;
  zoom: number;
  nightlineZoom: number;
  agentBrowserBinary?: string;
  browserExecutablePath?: string;
}

export interface AgentBrowserCommandRunner {
  run(arguments_: string[]): Promise<string>;
}

export class ProtomapsRenderer implements StationMapRenderer {
  private readonly sessionName = `divvy-${randomUUID()}`;
  private readonly commandRunner: AgentBrowserCommandRunner;
  private browserStarted = false;

  constructor(
    private readonly options: MapRendererOptions,
    commandRunner?: AgentBrowserCommandRunner,
  ) {
    this.commandRunner =
      commandRunner ??
      new ProcessAgentBrowserCommandRunner(
        options.agentBrowserBinary ??
          resolve(process.cwd(), "node_modules/.bin/agent-browser"),
      );
  }

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
      pixelRatio: config.mapPixelRatio,
      zoom: config.mapZoom,
      nightlineZoom: config.mapNightlineZoom,
      ...(config.agentBrowserExecutablePath
        ? { browserExecutablePath: config.agentBrowserExecutablePath }
        : {}),
    });
  }

  async render(
    station: StationSnapshot,
    renderOptions: {
      eyebrow: string;
      style?: AnnouncementStyle;
    } = { eyebrow: "New Divvy Station" },
  ): Promise<PostImage> {
    const announcementStyle = renderOptions.style ?? "civic";
    const temporaryDirectory = await fs.mkdtemp(
      resolve(os.tmpdir(), "divvy-render-"),
    );
    const htmlPath = resolve(temporaryDirectory, "card.html");
    const screenshotPath = resolve(temporaryDirectory, "card.png");

    try {
      await this.ensureBrowser();
      await fs.writeFile(
        htmlPath,
        completeMapDocument(
          divvyLogoDataUrl,
          municipalFontDataUrl,
          announcementStyle,
          {
            station,
            styleUrl: this.options.styleUrl,
            zoom:
              announcementStyle === "nightline"
                ? this.options.nightlineZoom
                : this.options.zoom,
            eyebrow: renderOptions.eyebrow,
            announcementStyle,
          },
        ),
        { mode: 0o600 },
      );
      await this.run(["open", pathToFileURL(htmlPath).href]);
      await this.run([
        "wait",
        "--fn",
        "window.__DIVVY_RENDER_STATE?.status === 'done' || window.__DIVVY_RENDER_STATE?.status === 'error'",
      ]);
      const state = parseRenderState(
        await this.run([
          "--json",
          "eval",
          "window.__DIVVY_RENDER_STATE",
        ]),
      );
      if (state.status !== "done") {
        throw new Error(state.error ?? "Map rendering failed");
      }
      await this.run(["--json", "screenshot", screenshotPath]);
      const png = await fs.readFile(screenshotPath);
      const bytes = await compressMap(png);
      const image: PostImage = {
        bytes,
        mimeType: "image/jpeg",
        alt: `Map centered on ${station.stationName.replace(/\*$/, "")}, a Divvy station at ${station.latitude.toFixed(5)}, ${station.longitude.toFixed(5)}, showing nearby streets.`,
        width: Math.round(this.options.width * this.options.pixelRatio),
        height: Math.round(this.options.height * this.options.pixelRatio),
      };
      assertImageSize(image);
      return image;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw new Error(redactBrowserSecrets(errorMessage(error)));
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    if (!this.browserStarted) {
      return;
    }
    try {
      await this.run(["close"]);
    } finally {
      this.browserStarted = false;
    }
  }

  private async ensureBrowser(): Promise<void> {
    if (this.browserStarted) {
      return;
    }

    this.browserStarted = true;
    try {
      await this.run([
        "--allow-file-access",
        "--args",
        [
          "--disable-dev-shm-usage",
          "--enable-unsafe-swiftshader",
          "--no-sandbox",
          "--use-angle=swiftshader-webgl",
          "--use-gl=angle",
        ].join(","),
        ...(this.options.browserExecutablePath
          ? ["--executable-path", this.options.browserExecutablePath]
          : []),
        "open",
        "about:blank",
      ]);
      await this.run([
        "set",
        "viewport",
        String(this.options.width),
        String(this.options.height),
        String(this.options.pixelRatio),
      ]);
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  private run(arguments_: string[]): Promise<string> {
    return this.commandRunner.run([
      "--session",
      this.sessionName,
      "--namespace",
      "divvy-bot",
      ...arguments_,
    ]);
  }
}

class ProcessAgentBrowserCommandRunner
  implements AgentBrowserCommandRunner
{
  constructor(private readonly binaryPath: string) {}

  run(arguments_: string[]): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        this.binaryPath,
        arguments_,
        {
          encoding: "utf8",
          env: {
            ...process.env,
            AGENT_BROWSER_DEFAULT_TIMEOUT: "45000",
            AGENT_BROWSER_IDLE_TIMEOUT_MS: "60000",
          },
          maxBuffer: 2 * 1024 * 1024,
          timeout: 60_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = [error.message, stderr, stdout]
              .map((value) => value.trim())
              .filter(Boolean)
              .join("\n");
            rejectPromise(
              new Error(
                redactBrowserSecrets(
                  detail || "agent-browser command failed",
                ),
              ),
            );
            return;
          }
          resolvePromise(stdout.trim());
        },
      );
    });
  }
}

interface RenderState {
  status: "loading" | "done" | "error";
  error?: string;
}

function parseRenderState(output: string): RenderState {
  try {
    const response = JSON.parse(output) as {
      success?: boolean;
      data?: { result?: RenderState };
      error?: unknown;
    };
    const state = response.data?.result;
    if (!response.success || !state) {
      throw new Error(
        typeof response.error === "string"
          ? response.error
          : "agent-browser returned no render state",
      );
    }
    return state;
  } catch (error) {
    throw new Error(
      `Could not parse agent-browser render state: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactBrowserSecrets(value: string): string {
  return value.replace(
    /([?&]key=)[^&\s"'<>\\]+/giu,
    "$1[REDACTED]",
  );
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

interface MapDocumentPayload {
  station: StationSnapshot;
  styleUrl: string;
  zoom: number;
  eyebrow: string;
  announcementStyle: AnnouncementStyle;
}

function completeMapDocument(
  logoDataUrl: string,
  fontDataUrl: string,
  style: AnnouncementStyle,
  payload: MapDocumentPayload,
): string {
  const base = mapDocument(logoDataUrl, fontDataUrl, style);
  const withMapLibreStyle = base.replace(
    "</head>",
    `<style>${mapLibreStyle}</style></head>`,
  );
  return withMapLibreStyle.replace(
    "</body>",
    `<script>${mapLibreScript}</script><script>${mapBootstrapScript(
      payload,
    )}</script></body>`,
  );
}

function mapBootstrapScript(payload: MapDocumentPayload): string {
  const serializedPayload = JSON.stringify(payload).replaceAll(
    "<",
    "\\u003c",
  );
  return `
    window.__DIVVY_RENDER_STATE = { status: "loading" };
    (async () => {
      try {
        const {
          station,
          styleUrl,
          zoom,
          eyebrow,
          announcementStyle
        } = ${serializedPayload};
        const title = document.querySelector("[data-title]");
        const details = document.querySelector("[data-docks]");
        const electricDetails = document.querySelector("[data-electric]");
        const eyebrowElement = document.querySelector("[data-eyebrow]");
        const statusElement = document.querySelector("[data-status]");
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
        statusElement.textContent = isElectrified
          ? "CHARGED"
          : announcementStyle === "nightline"
            ? "DEPLOYED"
            : "OPEN";
        statusElement.classList.toggle(
          "long",
          statusElement.textContent.length > 7
        );
        title.textContent = station.stationName.replace(/\\*$/, "");
        details.textContent = station.totalDocks + " docks";
        electricDetails.hidden = !station.isElectric;
        const stationNameLength = title.textContent.length;
        if (stationNameLength > 34) {
          title.classList.add("very-long");
        } else if (stationNameLength > 24) {
          title.classList.add("long");
        }

        await new Promise((resolvePromise, rejectPromise) => {
          const map = new maplibregl.Map({
            container: "map",
            style: styleUrl,
            center: [station.longitude, station.latitude],
            zoom,
            attributionControl: false,
            interactive: false,
            fadeDuration: 0,
            preserveDrawingBuffer: true
          });
          let loaded = false;
          const timeout = window.setTimeout(() => {
            rejectPromise(
              new Error("Timed out waiting for Protomaps to render")
            );
          }, 30000);

          map.on("error", (event) => {
            if (event && event.error) {
              window.clearTimeout(timeout);
              rejectPromise(event.error);
            }
          });
          map.on("load", () => {
            loaded = true;
          });
          map.on("idle", () => {
            if (!loaded) {
              return;
            }
            window.clearTimeout(timeout);
            resolvePromise();
          });
        });
        await document.fonts.ready;
        window.__DIVVY_RENDER_STATE = { status: "done" };
      } catch (error) {
        window.__DIVVY_RENDER_STATE = {
          status: "error",
          error:
            error && typeof error.message === "string"
              ? error.message
              : String(error)
        };
      }
    })();
  `;
}

function mapDocument(
  logoDataUrl: string,
  fontDataUrl: string,
  style: AnnouncementStyle,
): string {
  return style === "nightline"
    ? nightlineMapDocument(logoDataUrl, fontDataUrl)
    : civicMapDocument(logoDataUrl, fontDataUrl);
}

function civicMapDocument(logoDataUrl: string, fontDataUrl: string): string {
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
        filter: saturate(0.96) contrast(1.04) brightness(0.98);
      }
      .map-vignette {
        position: absolute;
        z-index: 3;
        inset: 0;
        background:
          linear-gradient(90deg, rgba(5, 26, 55, 0.12), transparent 62%, rgba(5, 26, 55, 0.14)),
          linear-gradient(180deg, rgba(5, 26, 55, 0.08) 0%, transparent 45%),
          linear-gradient(180deg, transparent 46%, rgba(5, 26, 55, 0.08) 59%, rgba(5, 26, 55, 0.8) 77%, #051a37 91%);
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
      }
      .civic-stars span {
        font: 400 39px/1 Arial, "Noto Sans Symbols 2", sans-serif;
      }
      .station-star {
        position: absolute;
        z-index: 5;
        top: 49%;
        left: 50%;
        width: 73px;
        height: 73px;
        color: #e4002b;
        filter: drop-shadow(0 2px 3px rgba(7, 29, 58, 0.34));
        font: 400 89px/0.82 Arial, "Noto Sans Symbols 2", sans-serif;
        text-align: center;
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
    <div class="civic-stars" aria-hidden="true">
      <span>✶</span><span>✶</span><span>✶</span><span>✶</span>
    </div>
    <div class="station-star" aria-hidden="true">✶</div>
    <div class="brand" aria-label="Divvy">
      <img src="${logoDataUrl}" alt="Divvy">
    </div>
    <section class="station-card" aria-label="Divvy station details">
      <p class="announcement-label" data-eyebrow></p>
      <p class="status" data-status></p>
      <h1 data-title></h1>
      <div class="details-row">
        <div class="details" data-docks></div>
        <div class="details electric" data-electric>⚡️ Electrified</div>
      </div>
    </section>
    <div class="civic-stripes" aria-hidden="true"></div>
    <div class="attribution">© Protomaps · © OpenStreetMap contributors</div>
  </body>
</html>`;
}

function nightlineMapDocument(
  logoDataUrl: string,
  fontDataUrl: string,
): string {
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
        background: #010205;
        color: #ffffff;
        font-family: "Big Shoulders Text", "Arial Narrow", sans-serif;
      }
      #map {
        filter: saturate(0.9) contrast(1.08) brightness(0.9);
      }
      .map-vignette {
        position: absolute;
        z-index: 3;
        inset: 0;
        background:
          radial-gradient(circle at 50% 48%, rgba(81, 194, 240, 0.05), transparent 24%, rgba(1, 2, 5, 0.12) 72%),
          linear-gradient(180deg, rgba(1, 2, 5, 0.1) 0%, transparent 48%),
          linear-gradient(180deg, transparent 46%, rgba(1, 2, 5, 0.08) 56%, rgba(1, 2, 5, 0.86) 73%, #010205 88%);
        pointer-events: none;
      }
      .station-star {
        position: absolute;
        z-index: 5;
        top: 50%;
        left: 50%;
        width: 73px;
        height: 73px;
        color: #e4002b;
        filter: drop-shadow(0 2px 3px rgba(1, 2, 5, 0.44));
        font: 400 89px/0.82 Arial, "Noto Sans Symbols 2", sans-serif;
        text-align: center;
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
        right: 34px;
        bottom: 40px;
        left: 34px;
        text-align: center;
      }
      .announcement-label {
        display: inline-flex;
        align-items: center;
        min-height: 40px;
        margin: 0 0 10px;
        padding: 3px 16px 1px;
        background: #e4002b;
        color: #ffffff;
        font-size: 25px;
        font-weight: 900;
        letter-spacing: 0.16em;
        line-height: 1;
        text-transform: uppercase;
      }
      .status {
        margin: 0 0 16px;
        color: #ffffff;
        font-size: 214px;
        font-weight: 900;
        letter-spacing: -0.045em;
        line-height: 0.8;
        text-shadow: 7px 7px 0 rgba(81, 194, 240, 0.82);
        text-transform: uppercase;
      }
      .status.long {
        font-size: 188px;
        letter-spacing: -0.035em;
      }
      h1 {
        margin: 0;
        color: #ffffff;
        font-size: 72px;
        font-weight: 800;
        line-height: 0.92;
        letter-spacing: -0.018em;
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
        gap: 18px;
        margin-top: 20px;
      }
      .details {
        display: inline-flex;
        align-items: center;
        color: #b7bec8;
        font-size: 26px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .details + .details::before {
        margin-right: 18px;
        color: #51c2f0;
        content: "/";
      }
      .details.electric {
        color: #b7bec8;
      }
      .details[hidden] {
        display: none;
      }
      .attribution {
        position: absolute;
        z-index: 5;
        right: 18px;
        bottom: 12px;
        color: rgba(255, 255, 255, 0.36);
        font: 500 11px/1 Roboto, Arial, sans-serif;
        line-height: 1;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="map-vignette"></div>
    <div class="station-star" aria-hidden="true">✶</div>
    <div class="brand" aria-label="Divvy">
      <img src="${logoDataUrl}" alt="Divvy">
    </div>
    <section class="station-card" aria-label="Divvy station details">
      <p class="announcement-label" data-eyebrow></p>
      <p class="status" data-status></p>
      <h1 data-title></h1>
      <div class="details-row">
        <div class="details">Now in service</div>
        <div class="details" data-docks></div>
        <div class="details electric" data-electric>⚡️ Electrified</div>
      </div>
    </section>
    <div class="attribution">© Protomaps · © OpenStreetMap contributors</div>
  </body>
</html>`;
}
