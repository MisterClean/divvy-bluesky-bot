export interface PostImage {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  alt: string;
  width: number;
  height: number;
}

export const MAX_IMAGE_BYTES = 1_000_000;

export function assertImageSize(image: PostImage): void {
  if (image.bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is ${image.bytes.length} bytes; maximum is ${MAX_IMAGE_BYTES}`,
    );
  }
}
