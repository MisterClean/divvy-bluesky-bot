import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  type AgentBrowserCommandRunner,
  ProtomapsRenderer,
  redactBrowserSecrets,
} from "../src/media/map-renderer.js";
import { station } from "./fixtures.js";

class FakeAgentBrowserRunner implements AgentBrowserCommandRunner {
  readonly commands: string[][] = [];
  renderedDocument = "";

  async run(arguments_: string[]): Promise<string> {
    this.commands.push(arguments_);

    const openIndex = arguments_.indexOf("open");
    const openTarget = openIndex >= 0 ? arguments_[openIndex + 1] : undefined;
    if (openTarget?.startsWith("file:")) {
      this.renderedDocument = await fs.readFile(
        fileURLToPath(openTarget),
        "utf8",
      );
    }

    const screenshotIndex = arguments_.indexOf("screenshot");
    if (screenshotIndex >= 0) {
      const screenshotPath = arguments_[screenshotIndex + 1];
      if (!screenshotPath) {
        throw new Error("Screenshot path was not provided");
      }
      await sharp({
        create: {
          width: 900,
          height: 900,
          channels: 3,
          background: "#dce8f2",
        },
      })
        .png()
        .toFile(screenshotPath);
      return JSON.stringify({ success: true, data: { path: screenshotPath } });
    }

    if (arguments_.includes("eval")) {
      return JSON.stringify({
        success: true,
        data: { result: { status: "done" } },
        error: null,
      });
    }

    return "";
  }
}

describe("ProtomapsRenderer agent-browser orchestration", () => {
  it("reuses one browser and applies the configured pixel ratio", async () => {
    const runner = new FakeAgentBrowserRunner();
    const renderer = new ProtomapsRenderer(
      {
        styleUrl:
          "https://api.protomaps.com/styles/v5/light/en.json?key=test-key",
        width: 600,
        height: 600,
        pixelRatio: 1.5,
        zoom: 17,
        nightlineZoom: 17.5,
      },
      runner,
    );

    try {
      const civic = await renderer.render(station(), {
        eyebrow: "New Divvy station",
        style: "civic",
      });
      const nightline = await renderer.render(
        station({
          id: "station-2",
          stationName: "A Very Long Electrified Divvy Station Name*",
          isElectric: true,
        }),
        {
          eyebrow: "Divvy station electrified",
          style: "nightline",
        },
      );

      expect(civic.mimeType).toBe("image/jpeg");
      expect(civic.width).toBe(900);
      expect(civic.height).toBe(900);
      expect(nightline.width).toBe(900);
      expect(runner.renderedDocument).toContain("maplibregl.Map");
      expect(runner.renderedDocument).toContain("nightline");
      expect(runner.renderedDocument).toContain('"zoom":17.5');

      const launchCommands = runner.commands.filter((command) =>
        command.includes("--allow-file-access"),
      );
      expect(launchCommands).toHaveLength(1);
      expect(launchCommands[0]).toContain(
        "--disable-dev-shm-usage,--enable-unsafe-swiftshader,--no-sandbox,--use-angle=swiftshader-webgl,--use-gl=angle",
      );
      expect(runner.commands).toContainEqual(
        expect.arrayContaining([
          "set",
          "viewport",
          "600",
          "600",
          "1.5",
        ]),
      );
    } finally {
      await renderer.close();
    }

    expect(runner.commands.at(-1)).toContain("close");
  });

  it("redacts Protomaps query keys from browser errors", async () => {
    expect(
      redactBrowserSecrets(
        "request failed https://example.test/style.json?key=secret-value&v=5",
      ),
    ).toBe(
      "request failed https://example.test/style.json?key=[REDACTED]&v=5",
    );
  });
});
