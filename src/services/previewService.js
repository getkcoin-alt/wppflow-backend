import { query } from "../db/index.js";
import { canThumbnail } from "./thumbnailService.js";
import { readMedia, savePreview } from "./mediaService.js";

// Photos saved before previews existed get theirs the first time a chat shows them. This runs behind
// the request: the chat opens straight away with the full photos and swaps in the previews on its
// next refresh.
const CONCURRENCY = 2;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const waiting = [];
const queued = new Set();
const failedAt = new Map();
let running = 0;

export const needsPreview = (a) =>
  a.thumb_key == null && canThumbnail(a.mime_type);

async function makeOne(a) {
  const buffer = await readMedia(a.storage_key);
  const preview = await savePreview(a.storage_key, buffer, a.mime_type);
  // NULL means "try again later" (the preview could not be saved); '' means the file has none.
  if (preview.thumb_key === null) throw new Error("preview not saved");
  await query(
    "UPDATE attachments SET thumb_key=$3,width=$4,height=$5 WHERE id=$1 AND tenant_id=$2 AND thumb_key IS NULL",
    [a.id, a.tenant_id, preview.thumb_key, preview.width, preview.height],
  );
}

function pump() {
  while (running < CONCURRENCY && waiting.length) {
    const a = waiting.shift();
    running++;
    makeOne(a)
      .catch((error) => {
        failedAt.set(a.id, Date.now());
        console.error("Photo preview unavailable:", error.message);
      })
      .finally(() => {
        running--;
        queued.delete(a.id);
        pump();
      });
  }
}

// Queues the attachments that still lack a preview; returns how many are on their way.
export function backfillPreviews(attachments) {
  let pending = 0;
  for (const a of attachments) {
    if (!needsPreview(a)) continue;
    if (Date.now() - (failedAt.get(a.id) || 0) < RETRY_AFTER_MS) continue;
    pending++;
    if (queued.has(a.id)) continue;
    queued.add(a.id);
    waiting.push(a);
  }
  pump();
  return pending;
}
