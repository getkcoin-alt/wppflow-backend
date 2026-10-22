import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fail } from "../middleware/http.js";
// 16 MB for photos, video and audio (close to WhatsApp's own limit), 64 MB for documents.
export const MEDIA_LIMIT_BYTES = 16 * 1024 * 1024;
export const DOCUMENT_LIMIT_BYTES = 64 * 1024 * 1024;
export const MAX_MEDIA_BYTES = DOCUMENT_LIMIT_BYTES; // upper bound for any single read
const OOXML = {
  doc: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
// Executables, scripts, HTML and SVG are deliberately absent: they are never stored.
export const mediaTypes = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/3gpp": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
  "audio/aac": "audio",
  "audio/mp4": "audio",
  "audio/x-m4a": "audio",
  "audio/amr": "audio",
  "application/pdf": "document",
  "text/plain": "document",
  "text/csv": "document",
  "application/zip": "document",
  "application/msword": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.ms-powerpoint": "document",
  [OOXML.doc]: "document",
  [OOXML.xls]: "document",
  [OOXML.ppt]: "document",
};
export const limitFor = (mime) =>
  mediaTypes[mime] === "document" ? DOCUMENT_LIMIT_BYTES : MEDIA_LIMIT_BYTES;
const megabytes = (bytes) => Math.round(bytes / 1024 / 1024);
// Only these can be shown inside the browser; everything else is offered as a download.
export const canOpenInline = (mime) =>
  mime === "application/pdf" || /^(image|video|audio)\//.test(mime || "");
export const mediaEnabled = () =>
  Boolean(
    process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY,
  );
// Tests replace how commands are sent so no real storage is touched; signing stays real.
let sendOverride;
export const setMediaSend = (fn) => {
  sendOverride = fn;
};
const sendCommand = (command) =>
  sendOverride ? sendOverride(command) : client().send(command);
function client() {
  if (!mediaEnabled()) throw fail(503, "Media storage is not configured");
  return new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
}
export function validateMedia(mime, bytes) {
  if (!mediaTypes[mime])
    throw fail(415, "This kind of file can't be saved yet.");
  if (!Number.isInteger(bytes) || bytes < 1)
    throw fail(400, "The file is empty.");
  if (bytes > limitFor(mime))
    throw fail(
      413,
      `Files over ${megabytes(limitFor(mime))} MB can't be saved. This one is ${Math.ceil(bytes / 1024 / 1024)} MB.`,
    );
}
export async function uploadUrl(key, mime, bytes) {
  return getSignedUrl(
    client(),
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: mime,
      ContentLength: bytes,
    }),
    { expiresIn: 300 },
  );
}
const safeName = (name) =>
  String(name || "file").replace(/[\r\n"\\/]/g, "_").slice(0, 150);
// A short-lived address for one stored file. `inline` lets the browser show it (PDFs, images, video,
// audio) instead of downloading it; anything else is always a download.
export async function downloadUrl(key, { inline = false, mime, filename } = {}) {
  const show = inline && canOpenInline(mime);
  const name = filename ? `; filename="${safeName(filename)}"` : "";
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `${show ? "inline" : "attachment"}${name}`,
      ...(show ? { ResponseContentType: mime } : {}),
    }),
    { expiresIn: 300 },
  );
}
const textLike = (buffer) =>
  !buffer.includes(0) &&
  !/<(?:html|script|svg|!doctype)/i.test(buffer.subarray(0, 1024).toString());
export function validateContent(buffer, mime) {
  const ascii = buffer.subarray(0, 16).toString("latin1"),
    hex = buffer.subarray(0, 8).toString("hex");
  const mp4Family =
    ascii.slice(4, 8) === "ftyp" || /^(moov|mdat|wide|free)$/.test(ascii.slice(4, 8));
  const zip = hex.startsWith("504b0304") || hex.startsWith("504b0506");
  const ole = hex === "d0cf11e0a1b11ae1";
  const valid = {
    "image/jpeg": hex.startsWith("ffd8ff"),
    "image/png": hex === "89504e470d0a1a0a",
    "image/webp": ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP",
    "image/gif": ascii.startsWith("GIF8"),
    "video/mp4": mp4Family,
    "video/3gpp": mp4Family,
    "video/quicktime": mp4Family,
    "video/webm": hex.startsWith("1a45dfa3"),
    "audio/mpeg":
      ascii.startsWith("ID3") ||
      (buffer[0] === 255 && (buffer[1] & 224) === 224),
    "audio/ogg": ascii.startsWith("OggS"),
    "audio/webm": hex.startsWith("1a45dfa3"),
    "audio/aac":
      ascii.startsWith("ID3") || (buffer[0] === 255 && (buffer[1] & 240) === 240),
    "audio/mp4": mp4Family,
    "audio/x-m4a": mp4Family,
    "audio/amr": ascii.startsWith("#!AMR"),
    "application/pdf": ascii.startsWith("%PDF-"),
    "text/plain": textLike(buffer),
    "text/csv": textLike(buffer),
    "application/zip": zip,
    "application/msword": ole,
    "application/vnd.ms-excel": ole,
    "application/vnd.ms-powerpoint": ole,
    [OOXML.doc]: zip,
    [OOXML.xls]: zip,
    [OOXML.ppt]: zip,
  };
  if (!valid[mime])
    throw fail(400, "File contents do not match an allowed file type");
}
export async function verifyUpload(attachment) {
  const head = await sendCommand(
    new HeadObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: attachment.storage_key,
    }),
  );
  if (
    head.ContentLength !== Number(attachment.byte_size) ||
    head.ContentType !== attachment.mime_type
  )
    throw fail(400, "Uploaded file does not match its declared type or size");
  validateContent(
    await readMedia(attachment.storage_key),
    attachment.mime_type,
  );
}
export async function readMedia(key) {
  const result = await sendCommand(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
  );
  if (result.ContentLength > MAX_MEDIA_BYTES) {
    result.Body.destroy();
    throw fail(400, "File is too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of result.Body) {
    size += chunk.length;
    if (size > MAX_MEDIA_BYTES) {
      result.Body.destroy();
      throw fail(400, "File is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function storeIncoming(tenantId, buffer, mime) {
  validateMedia(mime, buffer.length);
  validateContent(buffer, mime);
  const key = `${tenantId}/${crypto.randomUUID()}`;
  await sendCommand(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: mime,
      Body: buffer,
    }),
  );
  return { id: crypto.randomUUID(), key, mime, bytes: buffer.length };
}

const REQUIRED = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
export const missingSettings = () => REQUIRED.filter((k) => !process.env[k]);

// What a person can act on, instead of the storage provider's raw error.
function explain(error) {
  const name = String(error?.name || error?.Code || "");
  const message = String(error?.message || "");
  if (/NoSuchBucket/i.test(name + message))
    return "The bucket was not found. Check S3_BUCKET.";
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|Forbidden|Unauthorized/i.test(name + message))
    return "The storage keys were refused. Check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, and that the key can read and write this bucket.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|timeout/i.test(name + message))
    return "Could not reach the storage endpoint. Check S3_ENDPOINT.";
  return message.slice(0, 160) || "Storage did not respond as expected.";
}

// Writes, reads back and deletes a tiny object: proves the server can really use the bucket.
export async function checkStorage() {
  if (!mediaEnabled())
    return { configured: false, ok: false, missing: missingSettings() };
  const key = `_health/${crypto.randomUUID()}`;
  const started = Date.now();
  try {
    await sendCommand(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: Buffer.from("scriwo storage check"),
        ContentType: "text/plain",
      }),
    );
    const read = await sendCommand(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    );
    read.Body?.destroy?.();
    await sendCommand(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    );
    return { configured: true, ok: true, ms: Date.now() - started };
  } catch (error) {
    await sendCommand(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    ).catch(() => {});
    return { configured: true, ok: false, error: explain(error) };
  }
}

const CHECK_BYTES = 5;
// A signed upload address for the browser to try, which is what exposes a bucket whose CORS rules
// do not allow this app's address.
export async function checkUploadTarget(tenantId) {
  const key = `${tenantId}/_check/${crypto.randomUUID()}`;
  return {
    key,
    url: await uploadUrl(key, "text/plain", CHECK_BYTES),
    bytes: CHECK_BYTES,
  };
}
export async function finishUploadCheck(tenantId, key) {
  if (!String(key).startsWith(`${tenantId}/_check/`))
    throw fail(400, "Invalid check key");
  try {
    const head = await sendCommand(
      new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    );
    await sendCommand(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    );
    return head.ContentLength === CHECK_BYTES
      ? { ok: true }
      : { ok: false, error: "The uploaded file was not the size that was sent." };
  } catch (error) {
    return {
      ok: false,
      error: /NotFound|NoSuchKey/i.test(String(error?.name))
        ? "The upload did not reach storage."
        : explain(error),
    };
  }
}
