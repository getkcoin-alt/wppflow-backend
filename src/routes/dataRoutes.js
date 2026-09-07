import express from 'express';
import { authenticateToken } from './authRoutes.js';
import {
  getContacts, createContact, deleteContact,
  getChats, createChat, updateChat,
  getMessages, createMessage,
  getCampaigns, createCampaign,
  getAutomations, createAutomation, toggleAutomation, deleteAutomation
} from '../db.js';

const router = express.Router();

// ─── CONTACTS ────────────────────────────────────────────────────────────────

router.get('/contacts', authenticateToken, async (req, res) => {
  try {
    const contacts = await getContacts(req.user.id);
    res.json({ status: 'success', contacts });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/contacts', authenticateToken, async (req, res) => {
  try {
    const contact = await createContact(req.user.id, req.body);
    res.status(201).json({ status: 'success', contact });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/contacts/:id', authenticateToken, async (req, res) => {
  try {
    await deleteContact(req.user.id, req.params.id);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── CHATS ───────────────────────────────────────────────────────────────────

router.get('/chats', authenticateToken, async (req, res) => {
  try {
    const chats = await getChats(req.user.id);
    res.json({ status: 'success', chats });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/chats', authenticateToken, async (req, res) => {
  try {
    const chat = await createChat(req.user.id, req.body);
    res.status(201).json({ status: 'success', chat });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.patch('/chats/:id', authenticateToken, async (req, res) => {
  try {
    await updateChat(req.user.id, req.params.id, req.body);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── MESSAGES ────────────────────────────────────────────────────────────────

router.get('/chats/:chatId/messages', authenticateToken, async (req, res) => {
  try {
    const messages = await getMessages(req.params.chatId, req.user.id);
    res.json({ status: 'success', messages });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/chats/:chatId/messages', authenticateToken, async (req, res) => {
  try {
    const message = await createMessage(req.params.chatId, req.body, req.user.id);
    res.status(201).json({ status: 'success', message });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

router.get('/campaigns', authenticateToken, async (req, res) => {
  try {
    const campaigns = await getCampaigns(req.user.id);
    res.json({ status: 'success', campaigns });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/campaigns', authenticateToken, async (req, res) => {
  try {
    const campaign = await createCampaign(req.user.id, req.body);
    res.status(201).json({ status: 'success', campaign });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── AUTOMATIONS ─────────────────────────────────────────────────────────────

router.get('/automations', authenticateToken, async (req, res) => {
  try {
    const automations = await getAutomations(req.user.id);
    res.json({ status: 'success', automations });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/automations', authenticateToken, async (req, res) => {
  try {
    const automation = await createAutomation(req.user.id, req.body);
    res.status(201).json({ status: 'success', automation });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.patch('/automations/:id/toggle', authenticateToken, async (req, res) => {
  try {
    const automation = await toggleAutomation(req.user.id, req.params.id);
    res.json({ status: 'success', automation });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/automations/:id', authenticateToken, async (req, res) => {
  try {
    await deleteAutomation(req.user.id, req.params.id);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

export default router;
