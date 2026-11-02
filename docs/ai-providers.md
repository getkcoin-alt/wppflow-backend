# AI providers

Riwo can run on several AI services at once. They are tried in order; when one is busy, rejects its key or is down, the next one
answers. Nothing about a provider's limits is hardcoded, because free tiers change often: check each provider's own limits page
before relying on a number.

## Adding a provider

On the server, run the script and paste the key at the hidden prompt. It never appears on screen, in the shell history or in a
log, is written to `.env` (permissions 600, with a dated backup) and restarts the backend:

```
cd /opt/wppflow-backend
bash scripts/add-ai-key.sh groq          # or gemini, cerebras, mistral, nvidia, openrouter, anthropic
bash scripts/add-ai-key.sh list          # which are set (never shows a key)
bash scripts/add-ai-key.sh order         # the order they are tried in
bash scripts/add-ai-key.sh self          # your own GPUs / any OpenAI-compatible server
bash scripts/add-ai-key.sh remove groq
```

Then open Admin, Riwo, and press "Run a test": it shows which providers work.

Where to get a key: Groq (console.groq.com/keys), Google Gemini (aistudio.google.com/apikey), Cerebras (cloud.cerebras.ai),
Mistral (console.mistral.ai), NVIDIA (build.nvidia.com), OpenRouter (openrouter.ai/keys), Anthropic (console.anthropic.com).
Check each provider's own page for its current free limits.

| Provider | Key variable | Notes |
|---|---|---|
| Groq | `GROQ_API_KEY` | OpenAI-compatible. Says it does not train on API data. |
| Google Gemini | `GEMINI_API_KEY` | The free tier may use what it receives to improve Google's products; a paid account does not (set `AI_GEMINI_DATA=no-training`). |
| Cerebras | `CEREBRAS_API_KEY` | Check its current free tier before relying on it. |
| Mistral | `MISTRAL_API_KEY` | The free "Experiment" tier asks you to allow training on your data. |
| NVIDIA NIM | `NVIDIA_API_KEY` | Trial access; limits vary by model. |
| OpenRouter | `OPENROUTER_API_KEY` | Free models, chosen automatically. Some of its providers keep what they receive. |
| Claude | `ANTHROPIC_API_KEY` | Paid. Does not train on API data. |
| Your own GPUs | `AI_SELF_BASE_URL`, `AI_SELF_MODEL`, optional `AI_SELF_API_KEY` | Any OpenAI-compatible server (vLLM, Ollama, LM Studio, TGI). Tried first, treated as private. |

Any other OpenAI-compatible service: name it in `AI_PROVIDERS` and set `AI_<NAME>_BASE_URL`, `AI_<NAME>_API_KEY`, `AI_<NAME>_MODEL`.

## Choosing the order

`AI_PROVIDERS=groq,gemini,openrouter` tries them in that order. Without it the order is: your own servers, Groq, Gemini, Cerebras,
Mistral, NVIDIA, OpenRouter, Claude. `AI_PROVIDER=anthropic` uses that one provider and no other.

## Per provider settings

`AI_<NAME>_MODELS` (models for writing), `AI_<NAME>_MODELS_FAST` (quick jobs such as summaries), `AI_<NAME>_RPM` (requests a minute
this server sends it), `AI_<NAME>_DATA` (`no-training`, `may-train` or `unknown`, what the provider does with what it is sent).

## Keeping customers' messages private

- A company owner can turn on **Private mode** in Admin, which limits Riwo to providers marked `no-training`.
- `AI_REQUIRE_NO_TRAINING=1` requires that for every company on the server.
- With neither, customer messages may go to any connected provider, including free tiers that may keep them. The app says so.

## Moving to your own GPUs

Set `AI_SELF_BASE_URL` (and `AI_SELF_MODEL`) and restart. It is tried first and the hosted providers become the fallback. Remove the
hosted keys when you no longer want a fallback.

## Customers know it is a machine, and can get a person

- Everything Riwo sends (Autopilot replies and Riwo's chats) ends with: "🤖 Automated reply from Riwo. Reply "human" to talk to a person."
- When a customer asks for a person (English, Arabic or Hinglish: "talk to a human", "I need an agent", "أريد التحدث مع موظف",
  "mujhe insaan se baat karni hai", or just "human" after a machine has been answering):
  Riwo and Autopilot stop answering that chat, the owner of the WhatsApp number (or the person it is assigned to) and the
  managers get a notification, the chat shows "Asked for a person" and goes to the top of Today, and the customer is told a
  person will reply (only if a machine had been talking to them).
- A teammate's reply clears the mark.
