export function formatConversation(c) {
  if (!c) return null;
  const lastMsg =
    typeof c.last_message === "string"
      ? JSON.parse(c.last_message)
      : c.last_message || {};

  return {
    id: c.id,
    tenantId: c.tenant_id,
    sessionName: c.session_name,
    sessionKey: c.session_name,
    channel: c.session_name,
    providerChatId: c.provider_chat_id || c.phone,
    contactId: c.contact_id || "",
    phone: c.phone,
    contactName: c.contact_name,
    avatar: c.avatar || "",
    unreadCount: Number(c.unread_count || 0),
    isGroup: Boolean(c.is_group),
    groupMembersCount: Number(c.group_members_count || 0),
    assignedTo: c.assigned_to || "",
    isClosed: Boolean(c.is_closed),
    isPinned: Boolean(c.is_pinned),
    isArchived: Boolean(c.is_archived),
    lastActiveEpoch: Number(c.last_active_epoch || 0),
    lastMessage: lastMsg,
    tags: Array.isArray(c.tags) ? c.tags : [],
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    // snake_case mirrors for backwards-compatibility
    tenant_id: c.tenant_id,
    session_name: c.session_name,
    provider_chat_id: c.provider_chat_id || c.phone,
    contact_name: c.contact_name,
    unread_count: Number(c.unread_count || 0),
    is_group: Boolean(c.is_group),
    last_active_epoch: Number(c.last_active_epoch || 0),
    last_message: lastMsg,
  };
}
