import type { StationSnapshot } from "../src/domain/station.js";

export function station(
  overrides: Partial<StationSnapshot> = {},
): StationSnapshot {
  return {
    id: "station-1",
    stationName: "State St & Lake St",
    shortName: "CHI00001",
    totalDocks: 19,
    docksInService: 19,
    status: "In Service",
    latitude: 41.8858,
    longitude: -87.6278,
    isElectric: false,
    ...overrides,
  };
}
