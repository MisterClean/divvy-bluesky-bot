import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps publishing disabled by default", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.publishEnabled).toBe(false);
    expect(config.protomapsStyleUrl).toBeUndefined();
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
