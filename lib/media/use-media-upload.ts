"use client";

import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  getImageDimensions,
  MAX_MEDIA_FILE_SIZE,
} from "./image-client";

export type MediaUploadMetadata = {
  folder?: string;
  tags?: string[];
};

function normalizeMetadata(
  metadata?: string | MediaUploadMetadata,
): MediaUploadMetadata {
  return typeof metadata === "string" ? { folder: metadata } : (metadata ?? {});
}

/**
 * Upload flow for the media library: generateUploadUrl -> POST file ->
 * create media record. Returns the new media id.
 */
export function useMediaUpload() {
  const generateUploadUrl = useMutation(api.cms.media.generateUploadUrl);
  const createMedia = useMutation(api.cms.media.create);
  const importFromUrlAction = useAction(api.cms.media.importFromUrl);
  const [isUploading, setIsUploading] = useState(false);

  async function upload(
    file: File,
    metadata?: string | MediaUploadMetadata,
  ): Promise<Id<"media">> {
    const normalized = normalizeMetadata(metadata);

    if (file.size > MAX_MEDIA_FILE_SIZE) {
      throw Object.assign(new Error(`${file.name}: file must be smaller than 10MB`), { code: "MEDIA_TOO_LARGE" });
    }
    if (!file.type.startsWith("image/")) {
      throw Object.assign(new Error(`${file.name}: only image files are supported`), { code: "MEDIA_NOT_IMAGE" });
    }

    const { width, height } = await getImageDimensions(file);

    const uploadUrl = await generateUploadUrl();
    const response = await fetch(uploadUrl, { method: "POST", body: file });
    if (!response.ok) {
      throw new Error(`${file.name}: upload failed (${response.statusText})`);
    }
    const { storageId } = (await response.json()) as { storageId: string };
    if (!storageId) throw new Error(`${file.name}: no storageId returned`);

    return createMedia({
      filename: file.name,
      storageId: storageId as Id<"_storage">,
      size: file.size,
      mimeType: file.type,
      width,
      height,
      folder: normalized.folder || undefined,
      tags: normalized.tags,
    });
  }

  /** Upload a list of files sequentially. Returns ids of successful uploads. */
  async function uploadMany(
    files: FileList | File[],
    metadata?: string | MediaUploadMetadata,
  ): Promise<Id<"media">[]> {
    setIsUploading(true);
    try {
      const ids: Id<"media">[] = [];
      for (const file of Array.from(files)) {
        ids.push(await upload(file, metadata));
      }
      setIsUploading(false);
      return ids;
    } catch (e) {
      setIsUploading(false);
      throw e;
    }
  }

  async function importFromUrl(
    url: string,
    metadata?: MediaUploadMetadata,
  ): Promise<Id<"media">> {
    setIsUploading(true);
    try {
      const id = await importFromUrlAction({
        url,
        folder: metadata?.folder || undefined,
        tags: metadata?.tags,
      });
      setIsUploading(false);
      return id;
    } catch (e) {
      setIsUploading(false);
      throw e;
    }
  }

  return { upload, uploadMany, importFromUrl, isUploading };
}
