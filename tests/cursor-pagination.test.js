import test from 'node:test';
import assert from 'node:assert';
import { getConversations } from '../src/services/conversationService.js';
import { getConversationMessages } from '../src/services/messageService.js';
import { registerTenantAndUser } from '../src/services/authService.js';
import { query } from '../src/db/index.js';

test('Cursor Pagination Suite', async (t) => {
  const tData = await registerTenantAndUser({
    name: 'Pagination User',
    email: `page_${Date.now()}@example.com`,
    password: 'Password@123',
    companyName: 'Page Testing'
  });
  const tenantId = tData.tenant.id;

  // Seed 5 conversations with different epochs
  for (let i = 1; i <= 5; i++) {
    await query(`
      INSERT INTO conversations (id, tenant_id, session_name, phone, contact_name, last_active_epoch)
      VALUES ($1, $2, 'primary-whatsapp', $3, $4, $5)
    `, [`conv_p_${i}_${Date.now()}`, tenantId, `91933333330${i}`, `Client ${i}`, 1000 + i * 10]);
  }

  await t.test('Fetch page 1 with limit 2', async () => {
    const page1 = await getConversations({
      tenantId,
      limit: 2
    });

    assert.strictEqual(page1.conversations.length, 2);
    assert.strictEqual(page1.hasMore, true);
    assert.ok(page1.nextCursor);

    // Fetch page 2 using cursor
    const page2 = await getConversations({
      tenantId,
      limit: 2,
      cursor: page1.nextCursor
    });

    assert.strictEqual(page2.conversations.length, 2);
    assert.strictEqual(page2.hasMore, true);
    assert.notStrictEqual(page1.conversations[0].id, page2.conversations[0].id, 'Page 2 items must not overlap Page 1');

    // Fetch page 3 (remaining item)
    const page3 = await getConversations({
      tenantId,
      limit: 2,
      cursor: page2.nextCursor
    });

    assert.strictEqual(page3.conversations.length, 1);
    assert.strictEqual(page3.hasMore, false);
  });
});
