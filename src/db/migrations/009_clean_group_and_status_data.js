export const version = "009_clean_group_and_status_data";
export async function up(client) {
  await client.query(`
    -- Group ids, Status feeds and channels were being stored as "contacts" named after
    -- whoever posted. Detach them from conversations (ON DELETE SET NULL) and remove them.
    UPDATE conversations SET contact_id=NULL
      WHERE contact_id IN (SELECT id FROM contacts WHERE phone ~ '@(g\\.us|broadcast|newsletter)$');
    DELETE FROM contacts WHERE phone ~ '@(g\\.us|broadcast|newsletter)$';

    -- WhatsApp Status feeds are not conversations: keep the rows (no data is destroyed)
    -- but archive them and clear their unread badges.
    UPDATE conversations SET is_archived=true, unread_count=0
      WHERE provider_chat_id ~ '@(broadcast|newsletter)$';

    -- Photo/video/sticker "text" that is really a base64 thumbnail (starts with /9j/...)
    UPDATE messages SET text = CASE type
        WHEN 'image' THEN '📷 Photo' WHEN 'video' THEN '🎥 Video' WHEN 'audio' THEN '🎵 Voice message'
        WHEN 'document' THEN '📄 Document' WHEN 'sticker' THEN 'Sticker' ELSE '' END
      WHERE type NOT IN ('text','internal_note') AND length(text) > 120 AND text !~ '\\s';
    UPDATE conversations SET last_message = jsonb_set(last_message, '{text}', to_jsonb('📷 Photo'::text))
      WHERE length(last_message->>'text') > 120 AND (last_message->>'text') !~ '\\s';
  `);
}
export async function down() {
  throw new Error(
    "Use a verified backup or forward repair; destructive rollback is disabled.",
  );
}
