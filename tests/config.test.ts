import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps publishing disabled by default", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.publishEnabled).toBe(false);
    expect(config.protomapsStyleUrl).toBeUndefined();
    expect(config.mapZoom).toBe(17);
    expect(config.mapNightlineZoom).toBe(17.5);
    expect(config.mapPixelRatio).toBe(1);
    expect(config.mapRenderTimeoutMs).toBe(75_000);
    expect(config.mapRenderMaxAttempts).toBe(2);
    expect(config.mapRenderRetryDelayMs).toBe(2_000);
  });

  it("parses an explicit browser path and map pixel ratio", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MAP_PIXEL_RATIO: "2",
      MAP_RENDER_TIMEOUT_MS: "90000",
      MAP_RENDER_MAX_ATTEMPTS: "3",
      MAP_RENDER_RETRY_DELAY_MS: "500",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium-browser",
    });
    expect(config.mapPixelRatio).toBe(2);
    expect(config.mapRenderTimeoutMs).toBe(90_000);
    expect(config.mapRenderMaxAttempts).toBe(3);
    expect(config.mapRenderRetryDelayMs).toBe(500);
    expect(config.agentBrowserExecutablePath).toBe(
      "/usr/bin/chromium-browser",
    );
  });

  it("builds the same hosted Protomaps style URL pattern as the website", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PROTOMAPS_KEY: "example-key",
    });
    expect(config.protomapsStyleUrl).toBe(
      "https://api.protomaps.com/styles/v5/light/en.json?key=example-key",
    );
  });

  it("requires publishing credentials before publishing can be enabled", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        PUBLISH_ENABLED: "true",
      }),
    ).toThrow();
  });
});
