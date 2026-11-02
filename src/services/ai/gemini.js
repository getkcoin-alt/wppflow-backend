import { postJson } from "./http.js";
import { tidy } from "../openRouter.js";
import { fail } from "../../middleware/http.js";

// Google's own API. The key goes in a header, never in the address, so it cannot end up in a log.
export async function askGemini(provider, model, { system, user, maxTokens = 1500 }) {
  const data = await postJson(`${provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    headers: { "x-goog-api-key": provider.key },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.4,
        // the 2.5 Flash models spend the answer's budget on hidden thinking unless it is switched off
        ...(/2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    },
  });
  const candidate = data?.candidates?.[0];
  if (data?.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") throw fail(422, "Riwo can't help with this one. Write the reply yourself.");
  const text = tidy((candidate?.content?.parts || []).map((p) => p?.text || "").join(""));
  if (!text) throw fail(502, "The AI provider returned no answer.");
  return { text, usage: { input_tokens: data?.usageMetadata?.promptTokenCount || 0, output_tokens: data?.usageMetadata?.candidatesTokenCount || 0 }, model };
}
