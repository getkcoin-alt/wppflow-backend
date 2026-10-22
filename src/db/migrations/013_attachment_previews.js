export const version = "013_attachment_previews";
export async function up(client) {
  await client.query(`
    -- A small preview of each photo (thumb_key, in object storage next to the original) and the
    -- photo's own size, so a chat can reserve the space before the image arrives. thumb_key stays
    -- NULL until a preview is made and becomes '' when the file can't produce one.
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS thumb_key VARCHAR(512);
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS width INT;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS height INT;
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
