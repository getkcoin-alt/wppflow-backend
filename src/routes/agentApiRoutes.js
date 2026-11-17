import express from "express";
import cors from "cors";
import { route } from "../middleware/http.js";
import { ENV } from "../config/env.js";
import { requireAgentKey, agentAuthLimiter, agentCallLimiter } from "../services/agents/keys.js";
import { toolsFor, runTool, publicError } from "../services/agents/tools.js";
import { agentInstructions } from "../services/agents/prompt.js";
import { buildOpenApi } from "../services/agents/openapi.js";
import { handleBody } from "../services/agents/mcp.js";
import { PROTOCOLS } from "../services/agents/config.js";

// The doors an AI agent comes through, with its own key (scr_ag_...). No other route accepts that key, and these accept nothing else.
//   /mcp, /mcp/:key     the MCP server (Streamable HTTP). The key goes in "Authorization: Bearer", or, for tools that can only be given an
//                       address (some chat apps' "connectors"), in the address itself: treat that address like a password.
//   /api/agent/v1/...   the same tools as plain REST, and the OpenAPI description that ChatGPT Actions and similar tools import.
// Both are called by programs and carry no cookies, so any website origin may call them: what protects them is the key.
const agentCors = cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"],
  exposedHeaders: ["WWW-Authenticate", "Retry-After", "Mcp-Session-Id"],
  maxAge: 86400,
});

// ── MCP ───────────────────────────────────────────────────────────────────────────────────────────
export const mcpRouter = express.Router();
mcpRouter.use(agentCors);

// This server has no stream to offer and no session to end: the protocol says to answer 405 to both
const noStream = (req, res) => res.set("Allow", "POST, OPTIONS").status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "This server answers POST requests only." } });
mcpRouter.get(["/", "/:key"], noStream);
mcpRouter.delete(["/", "/:key"], noStream);

mcpRouter.post(
  ["/", "/:key"],
  agentAuthLimiter,
  requireAgentKey,
  agentCallLimiter,
  express.json({ limit: "256kb", type: ["application/json", "application/*+json"] }),
  route(async (req, res) => {
    const header = req.headers["mcp-protocol-version"];
    if (header !== undefined && !PROTOCOLS.includes(String(header)))
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version "${String(header).slice(0, 20)}". Supported: ${PROTOCOLS.join(", ")}.` } });
    const answer = await handleBody(req.body, { agent: req.agent, io: req.app.get("io"), version: header ? String(header) : PROTOCOLS[1] });
    if (answer.status === 202) return res.status(202).end();
    return res.status(answer.status).json(answer.body);
  }),
);
// a body that is not JSON
mcpRouter.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body is not valid JSON." } });
  if (error?.type === "entity.too.large") return res.status(413).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "The request is too large." } });
  return next(error);
});

// ── REST ──────────────────────────────────────────────────────────────────────────────────────────
export const agentApiRouter = express.Router();
agentApiRouter.use(agentCors);

// public: it holds no secret. ?level=read|reply|full leaves out the tools that level cannot use.
agentApiRouter.get("/openapi.json", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json(buildOpenApi({ baseUrl: ENV.PUBLIC_API_URL, level: String(req.query.level || "full") }));
});

const keyed = [agentAuthLimiter, requireAgentKey, agentCallLimiter, express.json({ limit: "256kb" })];

agentApiRouter.get("/tools", ...keyed, (req, res) => res.json({ status: "success", tools: toolsFor(req.agent) }));
agentApiRouter.get("/prompt", ...keyed, (req, res) => {
  const prompt = agentInstructions(req.agent);
  if (req.query.format === "text") return res.type("text/plain").send(prompt);
  return res.json({ status: "success", prompt });
});
agentApiRouter.post(
  "/tools/:name",
  ...keyed,
  route(async (req, res) => {
    try {
      const result = await runTool({ agent: req.agent, name: req.params.name, args: req.body, io: req.app.get("io"), via: "rest" });
      res.json({ status: "success", result });
    } catch (error) {
      const problem = publicError(error);
      if (problem.retryAfter) res.set("Retry-After", String(problem.retryAfter));
      res.status(problem.status).json({ status: "error", code: problem.code, message: problem.message, ...(problem.fix ? { fix: problem.fix } : {}), ...(problem.retryAfter ? { retryAfter: problem.retryAfter } : {}) });
    }
  }),
);
