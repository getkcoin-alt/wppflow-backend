import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fail } from "../middleware/http.js";
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const mediaTypes = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "audio/mpeg": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
  "application/pdf": "document",
  "text/plain": "document",
};
export const mediaEnabled = () =>
  Boolean(
    process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY,
  );
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
  if (
    !mediaTypes[mime] ||
    !Number.isInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_MEDIA_BYTES
  )
    throw fail(400, "Unsupported file type or file larger than 10 MB");
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
export async function downloadUrl(key) {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: "attachment",
    }),
    { expiresIn: 300 },
  );
}
export function validateContent(buffer, mime) {
  const ascii = buffer.subarray(0, 16).toString("latin1"),
    hex = buffer.subarray(0, 8).toString("hex");
  const valid = {
    "image/jpeg": hex.startsWith("ffd8ff"),
    "image/png": hex === "89504e470d0a1a0a",
    "image/webp": ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP",
    "video/mp4": ascii.slice(4, 8) === "ftyp",
    "audio/mpeg":
      ascii.startsWith("ID3") ||
      (buffer[0] === 255 && (buffer[1] & 224) === 224),
    "audio/ogg": ascii.startsWith("OggS"),
    "audio/webm": hex.startsWith("1a45dfa3"),
    "application/pdf": ascii.startsWith("%PDF-"),
    "text/plain":
      !buffer.includes(0) &&
      !/<(?:html|script|svg|!doctype)/i.test(
        buffer.subarray(0, 1024).toString(),
      ),
  };
  if (!valid[mime])
    throw fail(400, "File contents do not match an allowed file type");
}
export async function verifyUpload(attachment) {
  const head = await client().send(
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
  const result = await client().send(
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
  await client().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: mime,
      Body: buffer,
    }),
  );
  return { id: crypto.randomUUID(), key, mime, bytes: buffer.length };
}
