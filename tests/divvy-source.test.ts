import { afterEach, describe, expect, it, vi } from "vitest";
import { DivvySource } from "../src/source/divvy-source.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DivvySource", () => {
  it("validates and normalizes the Socrata JSON response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "electric-1",
            station_name: "Example Station*",
            short_name: "CHI00001",
            total_docks: "19",
            docks_in_service: "17",
            status: "In Service",
            latitude: "41.88",
            longitude: "-87.63",
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const source = new DivvySource({
      url: "https://example.test/stations.json",
      timeoutMs: 1_000,
      maxRetries: 0,
      minimumStationCount: 1,
    });

    const stations = await source.fetchStations();

    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({
      totalDocks: 19,
      docksInService: 17,
      isElectric: true,
    });
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get("$limit")).toBe("50000");
    expect(requestedUrl.searchParams.get("$order")).toBe("id");
  });

  it("rejects an unexpectedly small snapshot instead of accepting partial state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const source = new DivvySource({
      url: "https://example.test/stations.json",
      timeoutMs: 1_000,
      maxRetries: 0,
      minimumStationCount: 500,
    });

    await expect(source.fetchStations()).rejects.toThrow(
      "expected at least 500",
    );
  });
});
