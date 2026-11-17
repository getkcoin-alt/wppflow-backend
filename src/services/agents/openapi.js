import { TOOLS, inputSchemaOf } from "./tools.js";
import { LEVELS, levelAllows } from "./config.js";

// The OpenAPI description of the REST mirror, built from the same tool list as the MCP server. It is what ChatGPT's "Actions" (and any
// tool that reads OpenAPI) imports. It holds no secrets, so it needs no key: the key is sent with each call as a Bearer token.
const short = (text, n = 300) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

export function buildOpenApi({ baseUrl, level = "full" } = {}) {
  const wanted = LEVELS.includes(level) ? level : "full";
  const paths = {};
  for (const tool of TOOLS.filter((t) => levelAllows(wanted, t.level))) {
    paths[`/api/agent/v1/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title,
        description: short(tool.description),
        // ChatGPT asks the person to confirm each call that changes something
        "x-openai-isConsequential": !tool.annotations.readOnlyHint,
        requestBody: { required: true, content: { "application/json": { schema: inputSchemaOf(tool) } } },
        responses: {
          200: {
            description: "The tool's result.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { status: { type: "string", enum: ["success"] }, result: { type: "object", additionalProperties: true } } },
              },
            },
          },
          default: {
            description: "An error you can act on: read the message and the fix.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", enum: ["error"] }, code: { type: "string" }, message: { type: "string" }, fix: { type: "string" }, retryAfter: { type: "integer" } },
                },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Scriwo WhatsApp inbox: agent API",
      version: "1.0.0",
      description: "Lets an AI agent work a company's shared WhatsApp inbox in Scriwo with the permissions its owner chose. Every call needs the agent key as a Bearer token.",
    },
    servers: [{ url: String(baseUrl || "").replace(/\/+$/, "") }],
    security: [{ bearerAuth: [] }],
    paths,
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "The agent key, shown once when the agent was made (scr_ag_...)." } } },
  };
}
