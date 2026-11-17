import { toolsFor, runTool, publicError } from "./tools.js";
import { agentInstructions } from "./prompt.js";
import { PROTOCOLS, SERVER_INFO } from "./config.js";

// A small Model Context Protocol server over "Streamable HTTP" (JSON-RPC 2.0 in a POST). It keeps no session: every call carries the agent's key,
// so there is nothing to lose when the server restarts, and any number of servers could answer. It answers with plain JSON (the protocol
// lets a server choose that over a stream) and offers tools and one prompt. Written by hand so Scriwo needs no new package for it; the
// official MCP client is used in the end-to-end check (docs/agents.md).

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const bad = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export const PROMPT = {
  name: "inbox_manager",
  title: "Work the WhatsApp inbox",
  description: "The rules for working this company's WhatsApp inbox as a careful teammate. Optionally say what to do now.",
  arguments: [{ name: "task", description: "What to do now, for example: answer the chats that are waiting.", required: false }],
};

const asText = (value) => {
  const text = JSON.stringify(value);
  return text.length > 150_000 ? `${text.slice(0, 150_000)}…(cut: too long; ask for less)` : text;
};

// One JSON-RPC message in, one out (null when nothing is to be sent back: a notification, or a reply to us)
export async function handleMessage(message, { agent, io = null, version = PROTOCOLS[0] } = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return bad(message?.id, -32600, "Invalid request: send a JSON-RPC 2.0 message.");
  if (typeof message.method !== "string") return null; // a response to something we never asked
  const { id, method, params } = message;
  const notification = id === undefined;
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: agentInstructions(agent),
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: toolsFor(agent) });
    case "tools/call": {
      if (typeof params?.name !== "string") return bad(id, -32602, "Invalid params: a tool call needs a name.");
      try {
        const result = await runTool({ agent, name: params.name, args: params.arguments, io, via: "mcp" });
        // 2025-06-18 clients also read the structured form
        return ok(id, { content: [{ type: "text", text: asText(result) }], ...(version >= "2025-06-18" ? { structuredContent: result } : {}) });
      } catch (error) {
        const problem = publicError(error);
        if (problem.code === "unknown_tool") return bad(id, -32602, problem.message);
        return ok(id, { isError: true, content: [{ type: "text", text: `${problem.message}${problem.fix ? ` ${problem.fix}` : ""}${problem.retryAfter ? ` (try again in ${problem.retryAfter} seconds)` : ""}` }] });
      }
    }
    case "prompts/list":
      return ok(id, { prompts: [PROMPT] });
    case "prompts/get": {
      if (params?.name !== PROMPT.name) return bad(id, -32602, `Unknown prompt "${String(params?.name).slice(0, 60)}".`);
      const task = typeof params?.arguments?.task === "string" ? params.arguments.task.trim().slice(0, 500) : "";
      return ok(id, { description: PROMPT.description, messages: [{ role: "user", content: { type: "text", text: `${agentInstructions(agent)}${task ? `\n\nTask: ${task}` : ""}` } }] });
    }
    case "resources/list":
      return ok(id, { resources: [] });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "logging/setLevel":
      return ok(id, {});
    default:
      return notification ? null : bad(id, -32601, `Method not found: ${method.slice(0, 60)}`);
  }
}

// The body of one POST: a message, or (older clients) a batch of them. Returns { status, body } for the HTTP answer.
export async function handleBody(body, ctx) {
  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) return { status: 400, body: bad(null, -32600, "Invalid request: a batch has 1 to 20 messages.") };
    const answers = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return answers.length ? { status: 200, body: answers } : { status: 202 };
  }
  if (!body || typeof body !== "object" || !Object.keys(body).length) return { status: 400, body: bad(null, -32600, "Invalid request: send a JSON-RPC 2.0 message as JSON.") };
  const answer = await handleMessage(body, ctx);
  return answer ? { status: answer.error?.code === -32600 ? 400 : 200, body: answer } : { status: 202 };
}
