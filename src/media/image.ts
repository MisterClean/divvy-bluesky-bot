import type { StationSnapshot } from "../domain/station.js";

export interface PostImage {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  alt: string;
  width: number;
  height: number;
}

export const MAX_IMAGE_BYTES = 1_000_000;

const DIVVY_DATASET_ID = "bbyy-e7gq";
const DIVVY_API_FIELDS = [
  "id",
  "station_name",
  "short_name",
  "total_docks",
  "docks_in_service",
  "status",
  "latitude",
  "longitude",
  "location",
] as const;

export function assertImageSize(image: PostImage): void {
  if (image.bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is ${image.bytes.length} bytes; maximum is ${MAX_IMAGE_BYTES}`,
    );
  }
}

export function createStationImageAlt(
  station: StationSnapshot,
  visualDescription: string,
): string {
  const electricStatus = station.isElectric ? "yes" : "no";

  return [
    visualDescription,
    [
      `Station ID: ${station.id}`,
      `station name: ${station.stationName}`,
      `short name: ${station.shortName || "(none)"}`,
      `total docks: ${station.totalDocks}`,
      `docks in service: ${station.docksInService}`,
      `status: ${station.status}`,
      `latitude: ${station.latitude}`,
      `longitude: ${station.longitude}`,
      `location: Point [${station.longitude}, ${station.latitude}]`,
      `electrified: ${electricStatus}`,
    ].join("; "),
    `City of Chicago API record: ${createStationApiUrl(station.id)}`,
  ].join("\n");
}

export function createStationApiUrl(stationId: string): string {
  const escapedStationId = stationId.replaceAll("'", "''");
  const query = [
    `SELECT ${DIVVY_API_FIELDS.join(", ")}`,
    "WHERE",
    `((upper(\`id\`) LIKE '%${escapedStationId.toUpperCase()}%')`,
    `AND \`id\` IN ('${escapedStationId}'))`,
  ].join(" ");
  const encodedQuery = encodeURIComponent(query).replaceAll("'", "%27");

  return `https://data.cityofchicago.org/api/v3/views/${DIVVY_DATASET_ID}/query.json?query=${encodedQuery}`;
}
