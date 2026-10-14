"use client";

const MAX_EDGE = 480;

export interface Thumb {
  blob: Blob;
  width: number;
  height: number;
}

function fit(w: number, h: number) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

async function encode(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((r) => canvas.toBlob(r, "image/webp", 0.8));
}

async function imageThumb(file: Blob): Promise<Thumb | null> {
  const full = await createImageBitmap(file); // honours EXIF orientation
  const { w, h } = fit(full.width, full.height);
  let src: ImageBitmap = full;
  try {
    // Browser-native high-quality downscale (Lanczos-ish) beats a single drawImage.
    src = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  } catch {
    /* older Safari: fall back to canvas scaling */
  }
  const blob = await encode(src, w, h);
  if (src !== full) src.close();
  const dims = { width: full.width, height: full.height };
  full.close();
  return blob ? { blob, ...dims } : null;
}

function videoThumb(file: Blob): Promise<Thumb | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const done = (r: Thumb | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 12_000);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.min(Math.max(0.5, d * 0.1), Math.max(0, d - 0.1));
    };
    video.onseeked = async () => {
      if (!video.videoWidth) return done(null);
      const { w, h } = fit(video.videoWidth, video.videoHeight);
      const blob = await encode(video, w, h).catch(() => null);
      done(blob ? { blob, width: video.videoWidth, height: video.videoHeight } : null);
    };
    video.onerror = () => done(null);
    video.src = url;
  });
}

export async function makeThumbnail(file: Blob, category: string): Promise<Thumb | null> {
  try {
    if (category === "image" && file.size < 80 * 1024 * 1024 && !/svg/.test(file.type)) return await imageThumb(file);
    if (category === "video") return await videoThumb(file);
  } catch {
    /* undecodable (e.g. HEIC on non-Safari) — the UI falls back to an icon */
  }
  return null;
}

/** Thumbnail from an already-loaded <img> (backfills files uploaded before thumbnails existed). */
export async function thumbFromImage(img: HTMLImageElement): Promise<Thumb | null> {
  if (!img.naturalWidth) return null;
  const { w, h } = fit(img.naturalWidth, img.naturalHeight);
  const blob = await encode(img, w, h).catch(() => null);
  return blob ? { blob, width: img.naturalWidth, height: img.naturalHeight } : null;
}

export async function uploadThumb(nodeId: string, thumb: Thumb) {
  await fetch(`/api/thumbs/${nodeId}?w=${thumb.width}&h=${thumb.height}`, {
    method: "PUT",
    headers: { "content-type": thumb.blob.type || "image/webp" },
    body: thumb.blob,
  });
}
