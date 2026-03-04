/**
 * Application-wide settings store — persists LLM configuration to SQLite
 * so users can configure providers via the web UI instead of editing .env.
 */

import { SettingsStore } from "./base-store";

export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class AppSettingsStore extends SettingsStore {
  protected initTables(): void {
    this.initSettings("app_settings");
  }

  /** Save LLM provider configuration */
  saveLLMConfig(cfg: LLMConfig): void {
    this.setSetting("llm_provider", cfg.provider);
    this.setSetting("llm_api_key", cfg.apiKey);
    if (cfg.baseUrl) {
      this.setSetting("llm_base_url", cfg.baseUrl);
    }
    if (cfg.model) {
      this.setSetting("llm_model", cfg.model);
    }
  }

  /** Load LLM provider configuration (returns null if not configured) */
  getLLMConfig(): LLMConfig | null {
    const provider = this.getSetting("llm_provider");
    if (!provider) return null;

    return {
      provider,
      apiKey: this.getSetting("llm_api_key") || "",
      baseUrl: this.getSetting("llm_base_url") || undefined,
      model: this.getSetting("llm_model") || undefined,
    };
  }

  /** Check whether LLM has been configured via the web UI */
  isLLMConfigured(): boolean {
    return this.getSetting("llm_provider") !== null;
  }
}
