import path from "node:path";
import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DB_PATH: z.string().min(1).default("data/divvy-bot.sqlite3"),
    SODA_URL: z
      .url()
      .default("https://data.cityofchicago.org/resource/bbyy-e7gq.json"),
    SODA_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    SODA_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    SODA_MIN_STATIONS: z.coerce.number().int().nonnegative().default(500),
    PUBLISH_ENABLED: booleanFromEnv.default(false),
    POST_LIMIT: z.coerce.number().int().positive().max(100).default(10),
    BLUESKY_SERVICE_URL: z.url().default("https://bsky.social"),
    BLUESKY_IDENTIFIER: z.string().min(1).optional(),
    BLUESKY_APP_PASSWORD: z.string().min(1).optional(),
    PROTOMAPS_KEY: z.string().min(1).optional(),
    PROTOMAPS_STYLE_URL: z.url().optional(),
    MAP_WIDTH: z.coerce.number().int().min(600).max(2400).default(1080),
    MAP_HEIGHT: z.coerce.number().int().min(600).max(2400).default(1350),
    MAP_PIXEL_RATIO: z.coerce.number().min(1).max(3).default(1),
    MAP_ZOOM: z.coerce.number().min(12).max(19).default(17),
    MAP_NIGHTLINE_ZOOM: z.coerce.number().min(12).max(19).default(17.5),
    AGENT_BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
    STREETVIEW_ENABLED: booleanFromEnv.default(false),
    GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
    STREETVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    OUTPUT_DIR: z.string().min(1).default("output"),
  })
  .superRefine((environment, context) => {
    if (environment.PUBLISH_ENABLED) {
      if (!environment.BLUESKY_IDENTIFIER) {
        context.addIssue({
          code: "custom",
          path: ["BLUESKY_IDENTIFIER"],
          message: "Required when PUBLISH_ENABLED=true",
        });
      }
      if (!environment.BLUESKY_APP_PASSWORD) {
        context.addIssue({
          code: "custom",
          path: ["BLUESKY_APP_PASSWORD"],
          message: "Required when PUBLISH_ENABLED=true",
        });
      }
      if (!environment.PROTOMAPS_KEY && !environment.PROTOMAPS_STYLE_URL) {
        context.addIssue({
          code: "custom",
          path: ["PROTOMAPS_KEY"],
          message:
            "PROTOMAPS_KEY or PROTOMAPS_STYLE_URL is required when publishing",
        });
      }
    }

    if (environment.STREETVIEW_ENABLED && !environment.GOOGLE_MAPS_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_MAPS_API_KEY"],
        message: "Required when STREETVIEW_ENABLED=true",
      });
    }
  });

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  databasePath: string;
  sodaUrl: string;
  sodaTimeoutMs: number;
  sodaMaxRetries: number;
  sodaMinStations: number;
  publishEnabled: boolean;
  postLimit: number;
  blueskyServiceUrl: string;
  blueskyIdentifier?: string;
  blueskyAppPassword?: string;
  protomapsStyleUrl?: string;
  mapWidth: number;
  mapHeight: number;
  mapPixelRatio: number;
  mapZoom: number;
  mapNightlineZoom: number;
  agentBrowserExecutablePath?: string;
  streetViewEnabled: boolean;
  googleMapsApiKey?: string;
  streetViewTimeoutMs: number;
  outputDirectory: string;
}

function resolveFromWorkingDirectory(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function loadConfig(
  input: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const environment = environmentSchema.parse(input);
  const protomapsStyleUrl =
    environment.PROTOMAPS_STYLE_URL ??
    (environment.PROTOMAPS_KEY
      ? `https://api.protomaps.com/styles/v5/light/en.json?key=${encodeURIComponent(environment.PROTOMAPS_KEY)}`
      : undefined);

  return {
    nodeEnv: environment.NODE_ENV,
    databasePath: resolveFromWorkingDirectory(environment.DB_PATH),
    sodaUrl: environment.SODA_URL,
    sodaTimeoutMs: environment.SODA_TIMEOUT_MS,
    sodaMaxRetries: environment.SODA_MAX_RETRIES,
    sodaMinStations: environment.SODA_MIN_STATIONS,
    publishEnabled: environment.PUBLISH_ENABLED,
    postLimit: environment.POST_LIMIT,
    blueskyServiceUrl: environment.BLUESKY_SERVICE_URL,
    ...(environment.BLUESKY_IDENTIFIER
      ? { blueskyIdentifier: environment.BLUESKY_IDENTIFIER }
      : {}),
    ...(environment.BLUESKY_APP_PASSWORD
      ? { blueskyAppPassword: environment.BLUESKY_APP_PASSWORD }
      : {}),
    ...(protomapsStyleUrl ? { protomapsStyleUrl } : {}),
    mapWidth: environment.MAP_WIDTH,
    mapHeight: environment.MAP_HEIGHT,
    mapPixelRatio: environment.MAP_PIXEL_RATIO,
    mapZoom: environment.MAP_ZOOM,
    mapNightlineZoom: environment.MAP_NIGHTLINE_ZOOM,
    ...(environment.AGENT_BROWSER_EXECUTABLE_PATH
      ? {
          agentBrowserExecutablePath:
            environment.AGENT_BROWSER_EXECUTABLE_PATH,
        }
      : {}),
    streetViewEnabled: environment.STREETVIEW_ENABLED,
    ...(environment.GOOGLE_MAPS_API_KEY
      ? { googleMapsApiKey: environment.GOOGLE_MAPS_API_KEY }
      : {}),
    streetViewTimeoutMs: environment.STREETVIEW_TIMEOUT_MS,
    outputDirectory: resolveFromWorkingDirectory(environment.OUTPUT_DIR),
  };
}
