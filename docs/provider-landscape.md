# LLM Provider Landscape

Comprehensive guide to all supported LLM providers. Configure via the web UI at `/setup` or manually in `.env`.

## Quick Comparison

| Provider | Type | Pricing (per 1M tokens) | Free Tier | Tool Calling | Setup URL |
|----------|------|------------------------|-----------|--------------|-----------|
| **DeepSeek** | OpenAI-compatible | $0.27 in / $1.10 out | No | Yes | [platform.deepseek.com](https://platform.deepseek.com/) |
| **Groq** | OpenAI-compatible | Varies by model | Yes (rate-limited) | Yes | [console.groq.com](https://console.groq.com/) |
| **Google Gemini** | Native SDK | Free–$1.25 in / $5 out | Yes (15 req/min) | Yes | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **OpenAI GPT-4o-mini** | Native | $0.15 in / $0.60 out | No | Yes | [platform.openai.com](https://platform.openai.com/api-keys) |
| **OpenAI GPT-4o** | Native | $2.50 in / $10 out | No | Yes | [platform.openai.com](https://platform.openai.com/api-keys) |
| **xAI Grok** | OpenAI-compatible | $0.30 in / $0.50 out | $25/mo free credits | Yes | [console.x.ai](https://console.x.ai/) |
| **Anthropic Claude** | Native SDK | $3 in / $15 out (Sonnet) | No | Yes | [console.anthropic.com](https://console.anthropic.com/) |
| **Ollama** | Local REST API | Free | N/A (local) | No | [ollama.com](https://ollama.com/download) |
| **OpenRouter** | OpenAI-compatible | Varies by model | Some free models | Yes | [openrouter.ai](https://openrouter.ai/keys) |
| **Together.ai** | OpenAI-compatible | From $0.20 | No | Yes | [together.xyz](https://api.together.xyz/settings/api-keys) |
| **Mistral** | OpenAI-compatible | From $0.10 in | No | Yes | [console.mistral.ai](https://console.mistral.ai/api-keys) |

## Provider Details

### DeepSeek
- **Base URL:** `https://api.deepseek.com/v1`
- **Recommended model:** `deepseek-chat` (DeepSeek V3)
- **Strengths:** Very low cost, strong reasoning, large context window (128K)
- **Notes:** Chinese company; strong at code and math tasks

### Groq
- **Base URL:** `https://api.groq.com/openai/v1`
- **Recommended model:** `llama-3.3-70b-versatile`
- **Strengths:** Extremely fast inference (custom LPU hardware), free tier
- **Rate limits:** Free: 30 req/min, 14,400 req/day
- **Notes:** Runs open-source models (Llama, Mixtral, Gemma)

### Google Gemini
- **Adapter:** Native (`@google/generative-ai` SDK)
- **Default model:** `gemini-2.5-flash`
- **Strengths:** Large context (1M tokens), multimodal, generous free tier
- **Rate limits:** Free: 15 req/min; Paid: 2000 req/min
- **Notes:** Set `GEMINI_API_KEY` in .env or configure via setup UI

### OpenAI
- **Base URL:** `https://api.openai.com/v1` (default, no override needed)
- **Models:** `gpt-4o-mini` (best value), `gpt-4o` (flagship)
- **Strengths:** Best overall tool calling, widely supported, reliable
- **Notes:** Set `OPENAI_API_KEY` in .env or configure via setup UI

### xAI Grok
- **Base URL:** `https://api.x.ai/v1`
- **Recommended model:** `grok-3-mini-fast`
- **Strengths:** Fast, generous rate limits, $25/mo free API credits
- **Notes:** OpenAI-compatible API

### Anthropic Claude
- **Adapter:** Native (`@anthropic-ai/sdk`)
- **Default model:** `claude-sonnet-4-6`
- **Strengths:** Excellent reasoning, safety, large context (200K)
- **Notes:** Set `ANTHROPIC_API_KEY` in .env or configure via setup UI

### Ollama (Local)
- **Base URL:** `http://localhost:11434` (default)
- **Default model:** `llama3`
- **Strengths:** Free, private, no API key needed, works offline
- **Limitations:** No tool calling support; slower than cloud providers
- **Setup:** Install Ollama, run `ollama pull llama3`, start the server

### OpenRouter
- **Base URL:** `https://openrouter.ai/api/v1`
- **Recommended model:** `openai/gpt-4o-mini` (or any model on the platform)
- **Strengths:** One API key accesses 200+ models from all providers
- **Notes:** Pay-per-use, pricing varies by model. Great for experimentation.

### Together.ai
- **Base URL:** `https://api.together.xyz/v1`
- **Recommended model:** `meta-llama/Llama-3.3-70B-Instruct-Turbo`
- **Strengths:** Fast inference of open-source models at scale
- **Notes:** Competitive pricing for Llama, Mistral, and other open models

### Mistral
- **Base URL:** `https://api.mistral.ai/v1`
- **Recommended model:** `mistral-small-latest`
- **Strengths:** Efficient models, strong multilingual support, European hosting
- **Notes:** Good balance of cost and capability

## Architecture

All providers except Gemini, Anthropic, and Ollama use the **OpenAI-compatible adapter** (`src/providers/llm/openai.ts`). This single adapter handles any provider that implements the OpenAI chat completions API by accepting a configurable `baseURL` and `model` parameter.

```
┌──────────────┐
│  LLMProvider  │  (interface in types.ts)
└──────┬───────┘
       │
  ┌────┴────┬──────────┬───────────┐
  │         │          │           │
Gemini  Anthropic   OpenAI*    Ollama
                   (adapter)
                      │
          ┌───────────┼───────────┐
          │           │           │
       OpenAI     DeepSeek     Groq
       xAI        Together    Mistral
       OpenRouter  Qwen        ...
```

## Configuration Priority

1. **Explicit `LLM_PROVIDER`** env var (highest priority)
2. **Database settings** from `/setup` UI (via `applyDbSettings()`)
3. **Auto-detect** from API keys: Anthropic > Gemini > OpenAI > Ollama
