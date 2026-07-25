import type { StationEventPayload } from "../domain/station.js";

export function createPostText(payload: StationEventPayload): string {
  const stationName = payload.station.stationName.replace(/\*$/, "");

  if (payload.type === "station.electrified") {
    return [
      "⚡ Divvy Station Electrified!",
      "",
      `📍 ${stationName}`,
      `🚲 ${payload.station.totalDocks} docks`,
      "🔌 This station now has charging docks.",
    ].join("\n");
  }

  return [
    "🆕 New Divvy Station Alert!",
    "",
    `📍 ${stationName}`,
    `🚲 ${payload.station.totalDocks} docks`,
    ...(payload.station.isElectric
      ? ["⚡ This station has charging docks."]
      : []),
  ].join("\n");
}

export function createStreetViewPostText(
  payload: StationEventPayload,
): string {
  const stationName = payload.station.stationName.replace(/\*$/, "");
  return `📸 Street view of ${stationName}`;
}
