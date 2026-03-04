# Provider Abstraction & Group Summarizer Design

## Goal

Replace hardcoded Gemini/AssemblyAI/Groq integrations with a configurable provider system. Allow users to choose their LLM and transcription backends. Generalize the metacrisis group summarizer to work with any WhatsApp group selected from the dashboard.

## 1. LLM Provider Abstraction

### Interface

```typescript
// src/providers/llm/types.ts
interface LLMProvider {
  generateJSON<T>(prompt: string, systemPrompt?: string): Promise<T>;
  generateText(prompt: string, systemPrompt?: string): Promise<string>;
  chat(messages: ChatMessage[], tools?: Tool[]): Promise<ChatResponse>;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

interface ChatResponse {
  text: string;
  toolCalls?: { name: string; args: Record<string, any> }[];
}
```

### Providers

| Provider | Env config | Model |
|----------|-----------|-------|
| Anthropic | `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | claude-sonnet-4-6 |
| Gemini | `LLM_PROVIDER=gemini` + `GEMINI_API_KEY` | gemini-2.5-flash |
| Ollama | `LLM_PROVIDER=ollama` + `OLLAMA_MODEL` + `OLLAMA_URL` | user-configured |
| Groq | `LLM_PROVIDER=groq` + `GROQ_API_KEY` | llama-3.3-70b-versatile |

### Factory

```typescript
// src/providers/llm/index.ts
export function getLLM(): LLMProvider {
  // reads LLM_PROVIDER from config, returns the right adapter
}
```

### Files to refactor

All 13 Gemini call sites switch from `GoogleGenerativeAI` to `getLLM()`:

- `src/extractor.ts` — event extraction (generateJSON)
- `src/verifier.ts` — 6 distinct calls: event verification from page, from source text, from URL, duplicate detection, semantic search, location check (mix of generateJSON and generateText)
- `src/apps/relationship/analyzer.ts` — daily analysis (generateJSON)
- `src/apps/relationship/updater.ts` — recommendation generation (generateJSON)
- `src/apps/relationship/routes.ts` — chat endpoint (chat with tools)
- `src/apps/metacrisis/summarizer.ts` — 4 calls: daily digest, weekly summary, event extraction, link scraping (generateJSON)
- `src/apps/friends/tagger.ts` — 3 calls: tag extraction, direct tag extraction, tag consolidation (generateJSON)

### Rate limiting

Each provider adapter handles its own rate limiting internally:
- Anthropic: respect 429 headers
- Gemini: existing 2s minimum interval + exponential backoff
- Ollama: no rate limiting (local)
- Groq: respect 429 headers

## 2. Transcription Provider Abstraction

### Interface

```typescript
// src/providers/transcription/types.ts
interface TranscriptionProvider {
  transcribe(audioBase64: string, mimetype: string): Promise<string>;
  transcribeWithSpeakers(audioBuffer: Buffer, mimetype: string): Promise<SpeakerTranscript>;
  supportsSpeakerDiarization: boolean;
}

interface SpeakerTranscript {
  text: string;
  utterances: { speaker: string; text: string; start: number; end: number }[];
}
```

### Providers

| Provider | Env config | Speaker support |
|----------|-----------|----------------|
| Groq Whisper | `TRANSCRIPTION_PROVIDER=groq` | No |
| AssemblyAI | `TRANSCRIPTION_PROVIDER=assemblyai` | Yes |
| Local whisper | `TRANSCRIPTION_PROVIDER=local` | No |

### Files to refactor

- `src/utils/transcription.ts` — currently Groq-only, becomes the factory
- `src/apps/recording/routes.ts` — currently AssemblyAI-only, uses provider
- `src/apps/calls/routes.ts` — currently AssemblyAI-only, uses provider

## 3. Group Summarizer Generalization

### Database changes

New table in MetacrisisStore:

```sql
CREATE TABLE IF NOT EXISTS monitored_groups (
  chat_name TEXT PRIMARY KEY,
  announcement_chat TEXT,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
);
```

### API changes

New endpoints on `/api/metacrisis`:

- `GET /api/metacrisis/groups/available` — lists all WhatsApp groups (calls whatsapp.getClient().getChats())
- `POST /api/metacrisis/groups/:chatName/monitor` — add group to monitoring
- `DELETE /api/metacrisis/groups/:chatName/monitor` — remove group
- `GET /api/metacrisis/groups/monitored` — list currently monitored groups

### Handler changes

- `createMetacrisisHandler` checks `metacrisisStore.isGroupMonitored(chatName)` instead of comparing to a single env var
- Daily digest and weekly summary iterate over all monitored groups
- `METACRISIS_CHAT_NAME` env var still works as a default if set (backward compat), but dashboard selections take priority

### Frontend changes

- `metacrisis.html` gets a group picker section
- On page load, fetch available groups and monitored state
- Toggle buttons to enable/disable monitoring per group

## 4. Configuration

### New .env vars

```
# LLM Provider (default: anthropic)
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=

# Ollama (if LLM_PROVIDER=ollama)
OLLAMA_MODEL=llama3.3
OLLAMA_URL=http://localhost:11434

# Transcription Provider (default: groq)
TRANSCRIPTION_PROVIDER=groq
```

### Backward compatibility

- If `GEMINI_API_KEY` is set and `LLM_PROVIDER` is not set, auto-select gemini
- If `LLM_PROVIDER` is not set and `ANTHROPIC_API_KEY` is set, auto-select anthropic
- Existing env vars (`GROQ_API_KEY`, `ASSEMBLYAI_API_KEY`) continue to work

## 5. New dependencies

- `@anthropic-ai/sdk` — Anthropic SDK
- `whisper-node` — local whisper.cpp bindings (optional peer dep)

## 6. What stays the same

- All prompts are provider-agnostic text (no changes needed)
- SQLite stores, WhatsApp client, Express server structure
- All frontend HTML/JS (except metacrisis group picker addition)
- Existing API routes and response formats
