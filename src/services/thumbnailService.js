import sharp from "sharp";

// Chat photos are shown as small previews and only the viewer loads the full file, so a long chat
// costs a few hundred kilobytes instead of tens of megabytes.
export const THUMBNAIL_EDGE = 480;
const THUMBNAIL_QUALITY = 74;
// A decompression bomb (a tiny file that expands to billions of pixels) must not exhaust memory.
const MAX_INPUT_PIXELS = 100_000_000;

export const canThumbnail = (mime) =>
  /^image\/(jpeg|png|webp|gif)$/.test(mime || "");

// Returns { buffer, mime, width, height } for the preview, where width and height are those of the
// photo as people see it (after the camera's rotation is applied), or null when the file can't be
// decoded. A bad image never stops a message from being saved.
export async function makeThumbnail(buffer, mime) {
  if (!canThumbnail(mime)) return null;
  try {
    const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" };
    const meta = await sharp(buffer, options).metadata();
    if (!meta.width || !meta.height) return null;
    const turned = meta.orientation >= 5; // 90° and 270° rotations swap the sides
    const out = await sharp(buffer, options)
      .rotate()
      .resize({
        width: THUMBNAIL_EDGE,
        height: THUMBNAIL_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toBuffer();
    return {
      buffer: out,
      mime: "image/webp",
      width: turned ? meta.height : meta.width,
      height: turned ? meta.width : meta.height,
    };
  } catch {
    return null;
  }
}
