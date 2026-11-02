import { postJson } from "./http.js";
import { tidy } from "../openRouter.js";
import { fail } from "../../middleware/http.js";

// Any server that speaks the OpenAI "chat completions" way: Groq, Cerebras, Mistral, NVIDIA, a model on your own GPUs.
export async function askOpenAiCompat(provider, model, { system, user, maxTokens = 1500 }) {
  const data = await postJson(`${provider.baseUrl}/chat/completions`, {
    headers: provider.key ? { authorization: `Bearer ${provider.key}` } : {},
    body: {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
    },
  });
  const raw = data?.choices?.[0]?.message?.content;
  const text = tidy(typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p?.text || "").join("") : "");
  if (!text) throw fail(502, "The AI provider returned no answer.");
  return { text, usage: { input_tokens: data?.usage?.prompt_tokens || 0, output_tokens: data?.usage?.completion_tokens || 0 }, model: data?.model || model };
}
