import { createHash } from "node:crypto";

export interface StationSnapshot {
  id: string;
  stationName: string;
  shortName: string;
  totalDocks: number;
  docksInService: number;
  status: string;
  latitude: number;
  longitude: number;
  isElectric: boolean;
}

export type StationEventType = "station.discovered" | "station.electrified";

export interface StationEventPayload {
  type: StationEventType;
  station: StationSnapshot;
  observedAt: string;
}

export function stationStateHash(station: StationSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        station.stationName,
        station.shortName,
        station.totalDocks,
        station.docksInService,
        station.status,
        station.latitude,
        station.longitude,
        station.isElectric,
      ]),
    )
    .digest("hex");
}

export function isElectricStation(
  stationName: string,
  shortName: string,
): boolean {
  return (
    stationName.trimEnd().endsWith("*") ||
    shortName.toLocaleLowerCase("en-US").includes("charging")
  );
}
