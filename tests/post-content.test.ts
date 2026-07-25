import { describe, expect, it } from "vitest";
import { createPostText } from "../src/publishing/post-content.js";
import { station } from "./fixtures.js";

describe("createPostText", () => {
  it("describes charging docks without retaining the source asterisk", () => {
    const text = createPostText({
      type: "station.discovered",
      station: station({
        stationName: "Example Station*",
        isElectric: true,
      }),
      observedAt: "2026-07-25T12:00:00.000Z",
    });

    expect(text).toContain("📍 Example Station");
    expect(text).not.toContain("Example Station*");
    expect(text).toContain("charging docks");
  });
});
