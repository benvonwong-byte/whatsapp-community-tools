/**
 * LLM provider factory.
 *
 * Call `getLLM()` from anywhere — it reads the resolved provider from config
 * and lazily instantiates + caches the concrete adapter.
 *
 * Provider modules are loaded with `require()` so that unused SDKs are never
 * pulled in (e.g. if the user only has Gemini, Anthropic SDK is not loaded).
 */

import { config } from "../../config";
import { resolveProvider } from "../../config";
import type { LLMProvider } from "./types";

// Re-export types for convenience
export type { LLMProvider, ChatMessage, ChatResponse, ToolCall, ToolDefinition } from "./types";
export { parseJSONResponse } from "./types";

let cached: LLMProvider | null = null;

/**
 * Get the singleton LLM provider instance.
 * The provider is determined by `resolveProvider()` in config.ts and cached
 * for the lifetime of the process.
 */
export function getLLM(): LLMProvider {
  if (cached) return cached;

  const provider = resolveProvider();

  switch (provider) {
    case "gemini": {
      const { GeminiProvider } = require("./gemini") as typeof import("./gemini");
      cached = new GeminiProvider(config.geminiApiKey);
      break;
    }
    case "anthropic": {
      const { AnthropicProvider } = require("./anthropic") as typeof import("./anthropic");
      cached = new AnthropicProvider(config.anthropicApiKey);
      break;
    }
    case "openai": {
      const { OpenAIProvider } = require("./openai") as typeof import("./openai");
      cached = new OpenAIProvider(
        config.openaiApiKey,
        config.openaiBaseUrl || undefined,
        config.openaiModel,
      );
      break;
    }
    case "ollama": {
      const { OllamaProvider } = require("./ollama") as typeof import("./ollama");
      cached = new OllamaProvider(config.ollamaModel, config.ollamaUrl);
      break;
    }
    default:
      throw new Error(
        `Unknown LLM provider "${provider}". ` +
          `Set LLM_PROVIDER to "gemini", "anthropic", "openai", or "ollama".`,
      );
  }

  console.log(`[llm] Using provider: ${provider}`);
  return cached;
}

/** Reset the cached provider (useful for tests or config changes). */
export function resetLLM(): void {
  cached = null;
}
