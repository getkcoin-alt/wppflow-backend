export const version = "019_labels_contact_names";
export async function up(client) {
  await client.query(`
    -- The name WhatsApp shows for a person is kept apart from the name the company gave them. A sync from
    -- WhatsApp updates the first and never overwrites a name somebody on the team typed.
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_name VARCHAR(255) NOT NULL DEFAULT '';
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS name_edited BOOLEAN NOT NULL DEFAULT false;
    UPDATE contacts SET whatsapp_name=name WHERE whatsapp_name='';

    -- Labels belong to one company: a name, a colour from a fixed set, many labels per contact.
    CREATE TABLE IF NOT EXISTS labels (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(40) NOT NULL,
      color VARCHAR(16) NOT NULL DEFAULT 'slate',
      created_by INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_tenant_name ON labels(tenant_id, lower(name));
    CREATE TABLE IF NOT EXISTS contact_labels (
      contact_id VARCHAR(64) NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      label_id VARCHAR(64) NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (contact_id, label_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_labels_label ON contact_labels(tenant_id, label_id);

    -- The free-text tags people already have become labels, one per name per company, and every contact keeps
    -- every tag it had. contacts.tags stays as a copy of the label names (broadcasts read it) and is kept in step.
    INSERT INTO labels(id, tenant_id, name, color)
    SELECT gen_random_uuid()::text, t.tenant_id, t.name,
           (ARRAY['blue','green','orange','purple','teal','pink','amber','indigo','red','slate'])[1 + ((row_number() OVER (PARTITION BY t.tenant_id ORDER BY lower(t.name)) - 1) % 10)::int]
    FROM (
      SELECT DISTINCT ON (c.tenant_id, lower(left(btrim(x.tag), 40))) c.tenant_id, left(btrim(x.tag), 40) AS name
      FROM contacts c, jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.tags)='array' THEN c.tags ELSE '[]'::jsonb END) AS x(tag)
      WHERE btrim(x.tag) <> ''
      ORDER BY c.tenant_id, lower(left(btrim(x.tag), 40)), left(btrim(x.tag), 40)
    ) t
    ON CONFLICT DO NOTHING;

    INSERT INTO contact_labels(contact_id, label_id, tenant_id)
    SELECT DISTINCT c.id, l.id, c.tenant_id
    FROM contacts c
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.tags)='array' THEN c.tags ELSE '[]'::jsonb END) AS x(tag)
    JOIN labels l ON l.tenant_id=c.tenant_id AND lower(l.name)=lower(left(btrim(x.tag), 40))
    WHERE btrim(x.tag) <> ''
    ON CONFLICT DO NOTHING;
  `);
}
