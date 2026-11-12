"use client";

export const MAX_MEDIA_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type ImageDimensions = {
  width?: number;
  height?: number;
};

export type FocalPoint = {
  x: number;
  y: number;
};

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function normalizeFocalPoint(focal?: Partial<FocalPoint> | null): FocalPoint {
  return {
    x: clampPercent(focal?.x ?? 50),
    y: clampPercent(focal?.y ?? 50),
  };
}

function revokeObjectUrl(url: string | undefined) {
  if (url) URL.revokeObjectURL(url);
}

function loadImage(source: Blob | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let objectUrl: string | undefined;

    img.onload = () => {
      revokeObjectUrl(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      revokeObjectUrl(objectUrl);
      reject(new Error("Could not load image"));
    };

    if (typeof source === "string") {
      img.crossOrigin = "anonymous";
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }
  });
}

/** Read intrinsic dimensions of an image in the browser. */
export async function getImageDimensions(
  source: Blob | string,
): Promise<ImageDimensions> {
  try {
    const img = await loadImage(source);
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    };
  } catch {
    return {};
  }
}
