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
  readonly renderedDocuments: string[] = [];
  renderedDocument = "";

  constructor(private renderErrorsRemaining = 0) {}

  async run(arguments_: string[]): Promise<string> {
    this.commands.push(arguments_);

    const openIndex = arguments_.indexOf("open");
    const openTarget = openIndex >= 0 ? arguments_[openIndex + 1] : undefined;
    if (openTarget?.startsWith("file:")) {
      this.renderedDocument = await fs.readFile(
        fileURLToPath(openTarget),
        "utf8",
      );
      this.renderedDocuments.push(this.renderedDocument);
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
      if (this.renderErrorsRemaining > 0) {
        this.renderErrorsRemaining -= 1;
        return JSON.stringify({
          success: true,
          data: {
            result: {
              status: "error",
              error: "Timed out waiting for Protomaps to render",
            },
          },
          error: null,
        });
      }
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
        renderTimeoutMs: 75_000,
        maxAttempts: 2,
        retryDelayMs: 0,
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
      expect(runner.renderedDocuments[0]).toContain(
        "filter: saturate(1) contrast(1.03) brightness(1.08)",
      );
      expect(runner.renderedDocuments[0]).toContain(
        "background: rgba(255, 255, 255, 0.97)",
      );
      expect(runner.renderedDocuments[0]).toContain(
        "0 8px 18px rgba(7, 29, 58, 0.22)",
      );
      expect(runner.renderedDocuments[0]).toContain(
        'id: "cta-bus-routes"',
      );
      expect(runner.renderedDocuments[0]).toContain(
        '"renderTimeoutMs":75000',
      );
      expect(runner.renderedDocuments[0]).toContain(
        'id: "cta-rail-stations"',
      );
      expect(runner.renderedDocuments[1]).toContain(
        "filter: saturate(0.98) contrast(1.05) brightness(1.12)",
      );
      expect(runner.renderedDocuments[1]).toContain(
        "0 8px 18px rgba(1, 2, 5, 0.32)",
      );
      expect(runner.renderedDocument).not.toContain(
        "filter: brightness(0) invert(1)",
      );

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

  it("retries a failed render with a fresh browser session", async () => {
    const runner = new FakeAgentBrowserRunner(1);
    const renderer = new ProtomapsRenderer(
      {
        styleUrl:
          "https://api.protomaps.com/styles/v5/light/en.json?key=test-key",
        width: 600,
        height: 600,
        pixelRatio: 1,
        zoom: 17,
        nightlineZoom: 17.5,
        renderTimeoutMs: 75_000,
        maxAttempts: 2,
        retryDelayMs: 0,
      },
      runner,
    );

    try {
      const image = await renderer.render(station());
      expect(image.mimeType).toBe("image/jpeg");
      expect(runner.renderedDocuments).toHaveLength(2);
      expect(
        runner.commands.filter((command) =>
          command.includes("--allow-file-access"),
        ),
      ).toHaveLength(2);
    } finally {
      await renderer.close();
    }
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
