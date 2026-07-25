import { describe, expect, it } from "vitest";
import {
  createStationApiUrl,
  createStationImageAlt,
} from "../src/media/image.js";
import { station } from "./fixtures.js";

describe("station image accessibility metadata", () => {
  it("includes every selected API field and a record-specific API URL", () => {
    const sample = station({
      id: "1859717767703464460",
      stationName: "Example Station*",
      shortName: "",
      isElectric: true,
    });
    const alt = createStationImageAlt(sample, "Announcement map.");

    expect(alt).toContain("Station ID: 1859717767703464460");
    expect(alt).toContain("station name: Example Station*");
    expect(alt).toContain("short name: (none)");
    expect(alt).toContain("total docks: 19");
    expect(alt).toContain("docks in service: 19");
    expect(alt).toContain("status: In Service");
    expect(alt).toContain("latitude: 41.8858");
    expect(alt).toContain("longitude: -87.6278");
    expect(alt).toContain("location: Point [-87.6278, 41.8858]");
    expect(alt).toContain("electrified: yes");
    expect(alt).toContain(createStationApiUrl(sample.id));
  });

  it("builds the City of Chicago v3 record query used by the data portal", () => {
    const url = createStationApiUrl("1859717767703464460");

    expect(
      url.startsWith(
        "https://data.cityofchicago.org/api/v3/views/bbyy-e7gq/query.json?query=",
      ),
    ).toBe(true);
    expect(url).toContain(
      "SELECT%20id%2C%20station_name%2C%20short_name%2C%20total_docks",
    );
    expect(url).toContain("upper(%60id%60)");
    expect(url).toContain("%271859717767703464460%27");
  });
});
