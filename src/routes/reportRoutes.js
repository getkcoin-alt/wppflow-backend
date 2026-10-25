import express from "express";
import { authenticateToken, requireTenantContext, requireRole } from "../middleware/auth.js";
import { route } from "../middleware/http.js";
import { teamResponse, agentEpisodes, leaderboardCsv, episodesCsv, dailySummary, dailyChats, getSettings, saveSettings } from "../services/reportService.js";

const router = express.Router();
// Owners and administrators only: these figures are about the people who work for the company.
router.use(authenticateToken, requireTenantContext, requireRole("owner", "admin"));
const filters = (q) => ({ from: q.from || undefined, to: q.to || undefined, team: String(q.team || ""), sessionName: String(q.sessionName || "") });
const sendCsv = (res, name, text) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(`﻿${text}`);
};

router.get(
  "/team-response",
  route(async (req, res) => {
    const report = await teamResponse(req.tenantId, filters(req.query));
    if (req.query.format === "csv") return sendCsv(res, `reply-times-${report.range.from}-to-${report.range.to}.csv`, leaderboardCsv(report));
    res.json({ status: "success", ...report });
  }),
);
router.get(
  "/team-response/episodes",
  route(async (req, res) => {
    const rows = await agentEpisodes(req.tenantId, { ...filters(req.query), userId: req.query.userId });
    if (req.query.format === "csv") return sendCsv(res, "reply-times-detail.csv", episodesCsv(rows));
    res.json({ status: "success", episodes: rows });
  }),
);
router.get(
  "/daily",
  route(async (req, res) => {
    res.json({ status: "success", ...(await dailySummary(req.tenantId, String(req.query.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10)))) });
  }),
);
router.get(
  "/daily/chats",
  route(async (req, res) => {
    res.json({ status: "success", chats: await dailyChats(req.tenantId, { date: String(req.query.date || ""), sessionName: String(req.query.sessionName || ""), team: String(req.query.team || ""), userId: String(req.query.userId || "") }) });
  }),
);
router.get(
  "/settings",
  route(async (req, res) => {
    res.json({ status: "success", settings: await getSettings(req.tenantId) });
  }),
);
router.put(
  "/settings",
  route(async (req, res) => {
    res.json({ status: "success", settings: await saveSettings(req.tenantId, req.body || {}) });
  }),
);
export default router;
