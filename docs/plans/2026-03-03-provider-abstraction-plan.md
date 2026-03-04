# Provider Abstraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded Gemini/AssemblyAI/Groq integrations with a configurable multi-provider system, and generalize the metacrisis group summarizer to work with any WhatsApp group.

**Architecture:** Create `src/providers/llm/` and `src/providers/transcription/` adapter layers. Each provider implements a shared interface. A factory function reads config to return the active provider. All 13+ Gemini call sites and 3 transcription call sites get refactored to use the adapter.

**Tech Stack:** `@anthropic-ai/sdk` (new dep), existing `@google/generative-ai`, `assemblyai`, Groq REST API. `whisper-node` for local transcription (optional).

---

### Task 1: Install Anthropic SDK dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the Anthropic SDK**

Run: `npm install @anthropic-ai/sdk`

**Step 2: Verify installation**

Run: `node -e "require('@anthropic-ai/sdk')"`
Expected: No errors

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @anthropic-ai/sdk dependency"
```

---

### Task 2: Create LLM provider interface and types

**Files:**
- Create: `src/providers/llm/types.ts`

**Step 1: Create the shared types file**

```typescript
// src/providers/llm/types.ts

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ChatResponse {
  text: string;
  toolCalls?: ToolCall[];
}

export interface LLMProvider {
  /**
   * Generate a response and parse it as JSON.
   * Strips markdown code fences and extracts the JSON object/array.
   */
  generateJSON<T = any>(prompt: string, systemPrompt?: string): Promise<T>;

  /**
   * Generate a plain text response.
   */
  generateText(prompt: string, systemPrompt?: string): Promise<string>;

  /**
   * Multi-turn chat with optional tool/function calling.
   * Returns the final text response and any pending tool calls.
   */
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse>;

  /**
   * Continue a chat after providing tool results.
   * Takes the previous messages plus the tool result.
   */
  chatWithToolResult(
    messages: ChatMessage[],
    toolName: string,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse>;
}

/**
 * Parse a raw LLM text response that may contain markdown fences into a JSON value.
 * Shared across all providers.
 */
export function parseJSONResponse(text: string): any {
  let jsonStr = text.trim();
  // Strip markdown code fences
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  // Find outermost JSON structure
  const firstBrace = jsonStr.indexOf("{");
  const firstBracket = jsonStr.indexOf("[");
  if (firstBrace === -1 && firstBracket === -1) {
    return JSON.parse(jsonStr); // Let it throw if invalid
  }
  const start = firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket);
  const isArray = jsonStr[start] === "[";
  const end = isArray ? jsonStr.lastIndexOf("]") : jsonStr.lastIndexOf("}");
  if (end === -1) return JSON.parse(jsonStr);
  jsonStr = jsonStr.slice(start, end + 1);
  return JSON.parse(jsonStr);
}
```

**Step 2: Commit**

```bash
git add src/providers/llm/types.ts
git commit -m "feat: add LLM provider interface and shared types"
```

---

### Task 3: Create Gemini provider adapter

Extract the existing Gemini logic into the adapter pattern.

**Files:**
- Create: `src/providers/llm/gemini.ts`

**Step 1: Create the Gemini adapter**

```typescript
// src/providers/llm/gemini.ts
import { GoogleGenerativeAI, GenerateContentResult, SchemaType } from "@google/generative-ai";
import { LLMProvider, ChatMessage, ToolDefinition, ChatResponse, parseJSONResponse } from "./types";

// Rate limiting — shared across all calls
let lastCallTime = 0;
const MIN_INTERVAL = 2_000;

async function rateLimit() {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastCallTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallTime = Date.now();
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimit();
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status || err?.httpStatusCode;
      if (status === 429 && attempt < retries) {
        const backoff = Math.min(30_000, 10_000 * (attempt + 1));
        console.log(`[llm:gemini] Rate limited (429), retrying in ${(backoff / 1000).toFixed(0)}s...`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Rate limit retries exhausted");
}

export class GeminiProvider implements LLMProvider {
  private model: any;
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string, modelName = "gemini-2.5-flash") {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: modelName });
  }

  async generateJSON<T = any>(prompt: string, systemPrompt?: string): Promise<T> {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const text = await withRetry(async () => {
      const result: GenerateContentResult = await this.model.generateContent(fullPrompt);
      return result.response.text();
    });
    return parseJSONResponse(text) as T;
  }

  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    return withRetry(async () => {
      const result: GenerateContentResult = await this.model.generateContent(fullPrompt);
      return result.response.text();
    });
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    const geminiTools = tools?.length ? [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: SchemaType.STRING, description: String(v) }])
          ),
          required: Object.keys(t.parameters),
        },
      })),
    }] : undefined;

    const model = this.genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
      ...(geminiTools ? { tools: geminiTools } : {}),
    });

    // Build history (all messages except the last)
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === "assistant" ? "model" as const : "user" as const,
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history });
    const lastMsg = messages[messages.length - 1];

    await rateLimit();
    const result = await chat.sendMessage(lastMsg.content);

    const calls = result.response.functionCalls();
    return {
      text: result.response.text() || "",
      toolCalls: calls?.map((fc: any) => ({ name: fc.name, args: fc.args || {} })),
    };
  }

  async chatWithToolResult(
    messages: ChatMessage[],
    toolName: string,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    // For Gemini, we rebuild the full chat and send the function response
    const geminiTools = tools?.length ? [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: SchemaType.STRING, description: String(v) }])
          ),
          required: Object.keys(t.parameters),
        },
      })),
    }] : undefined;

    const model = this.genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
      ...(geminiTools ? { tools: geminiTools } : {}),
    });

    const history = messages.map(m => ({
      role: m.role === "assistant" ? "model" as const : "user" as const,
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history });

    await rateLimit();
    const result = await chat.sendMessage([{
      functionResponse: {
        name: toolName,
        response: { result: toolResult },
      },
    }]);

    const calls = result.response.functionCalls();
    return {
      text: result.response.text() || "",
      toolCalls: calls?.map((fc: any) => ({ name: fc.name, args: fc.args || {} })),
    };
  }
}
```

**Step 2: Commit**

```bash
git add src/providers/llm/gemini.ts
git commit -m "feat: add Gemini LLM provider adapter"
```

---

### Task 4: Create Anthropic provider adapter

**Files:**
- Create: `src/providers/llm/anthropic.ts`

**Step 1: Create the Anthropic adapter**

```typescript
// src/providers/llm/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import { LLMProvider, ChatMessage, ToolDefinition, ChatResponse, parseJSONResponse } from "./types";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private modelName: string;

  constructor(apiKey: string, modelName = "claude-sonnet-4-6") {
    this.client = new Anthropic({ apiKey });
    this.modelName = modelName;
  }

  async generateJSON<T = any>(prompt: string, systemPrompt?: string): Promise<T> {
    const text = await this.generateText(prompt, systemPrompt);
    return parseJSONResponse(text) as T;
  }

  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 8192,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    const anthropicTools = tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [k, { type: "string", description: String(v) }])
        ),
        required: Object.keys(t.parameters),
      },
    }));

    // Separate system messages from conversation
    const systemMsgs = messages.filter(m => m.role === "system");
    const chatMsgs = messages.filter(m => m.role !== "system");

    const fullSystem = [systemPrompt, ...systemMsgs.map(m => m.content)].filter(Boolean).join("\n\n");

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 8192,
      ...(fullSystem ? { system: fullSystem } : {}),
      messages: chatMsgs.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
    });

    let text = "";
    const toolCalls: ChatResponse["toolCalls"] = [];

    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use") {
        toolCalls.push({ name: block.name, args: block.input as Record<string, any> });
      }
    }

    return { text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  async chatWithToolResult(
    messages: ChatMessage[],
    toolName: string,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    // For Anthropic, we need to construct the full message history with tool_use and tool_result blocks
    // Simplified: append the tool result as a user message and continue
    const augmentedMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: `[Tool result for ${toolName}]: ${toolResult}` },
    ];
    return this.chat(augmentedMessages, tools, systemPrompt);
  }
}
```

**Step 2: Commit**

```bash
git add src/providers/llm/anthropic.ts
git commit -m "feat: add Anthropic LLM provider adapter"
```

---

### Task 5: Create Ollama provider adapter

**Files:**
- Create: `src/providers/llm/ollama.ts`

**Step 1: Create the Ollama adapter**

```typescript
// src/providers/llm/ollama.ts
import { LLMProvider, ChatMessage, ToolDefinition, ChatResponse, parseJSONResponse } from "./types";

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private modelName: string;

  constructor(modelName = "llama3.3", baseUrl = "http://localhost:11434") {
    this.modelName = modelName;
    this.baseUrl = baseUrl;
  }

  private async callOllama(prompt: string, system?: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        prompt,
        system: system || undefined,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.response || "";
  }

  async generateJSON<T = any>(prompt: string, systemPrompt?: string): Promise<T> {
    const text = await this.callOllama(prompt, systemPrompt);
    return parseJSONResponse(text) as T;
  }

  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    return this.callOllama(prompt, systemPrompt);
  }

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    // Ollama chat API
    const ollamaMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const body: any = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: false,
    };
    if (systemPrompt) {
      body.messages = [{ role: "system", content: systemPrompt }, ...body.messages];
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama chat error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return { text: data.message?.content || "" };
    // Note: Ollama doesn't support tool calling natively
  }

  async chatWithToolResult(
    messages: ChatMessage[],
    toolName: string,
    toolResult: string,
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    const augmented: ChatMessage[] = [
      ...messages,
      { role: "user", content: `[Result from ${toolName}]: ${toolResult}` },
    ];
    return this.chat(augmented, tools, systemPrompt);
  }
}
```

**Step 2: Commit**

```bash
git add src/providers/llm/ollama.ts
git commit -m "feat: add Ollama LLM provider adapter"
```

---

### Task 6: Create LLM provider factory

**Files:**
- Create: `src/providers/llm/index.ts`
- Modify: `src/config.ts`

**Step 1: Update config with new provider settings**

Add to `src/config.ts` in the config object (after the existing fields):

```typescript
// LLM provider
llmProvider: process.env.LLM_PROVIDER || "",
anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
ollamaModel: process.env.OLLAMA_MODEL || "llama3.3",
ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
// Transcription provider
transcriptionProvider: process.env.TRANSCRIPTION_PROVIDER || "",
```

Update `validateConfig()` to handle multiple providers:

```typescript
export function validateConfig() {
  const provider = resolveProvider();
  if (provider === "gemini" && !config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini. Set it in your .env file.");
  }
  if (provider === "anthropic" && !config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic. Set it in your .env file.");
  }
}

/** Auto-detect the LLM provider based on which API key is set */
export function resolveProvider(): string {
  if (config.llmProvider) return config.llmProvider;
  if (config.anthropicApiKey) return "anthropic";
  if (config.geminiApiKey) return "gemini";
  return ""; // No provider configured
}
```

**Step 2: Create the factory**

```typescript
// src/providers/llm/index.ts
import { LLMProvider } from "./types";
import { config, resolveProvider } from "../../config";

let cachedProvider: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (cachedProvider) return cachedProvider;

  const provider = resolveProvider();

  switch (provider) {
    case "anthropic": {
      const { AnthropicProvider } = require("./anthropic");
      cachedProvider = new AnthropicProvider(config.anthropicApiKey);
      break;
    }
    case "gemini": {
      const { GeminiProvider } = require("./gemini");
      cachedProvider = new GeminiProvider(config.geminiApiKey);
      break;
    }
    case "ollama": {
      const { OllamaProvider } = require("./ollama");
      cachedProvider = new OllamaProvider(config.ollamaModel, config.ollamaUrl);
      break;
    }
    default:
      throw new Error(
        `No LLM provider configured. Set LLM_PROVIDER and the corresponding API key in .env.\n` +
        `Options: anthropic (ANTHROPIC_API_KEY), gemini (GEMINI_API_KEY), ollama (OLLAMA_MODEL)`
      );
  }

  console.log(`[llm] Using provider: ${provider}`);
  return cachedProvider;
}

export { LLMProvider } from "./types";
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No type errors related to the new files

**Step 4: Commit**

```bash
git add src/providers/llm/index.ts src/config.ts
git commit -m "feat: add LLM provider factory with auto-detection"
```

---

### Task 7: Refactor extractor.ts to use LLM provider

**Files:**
- Modify: `src/extractor.ts`

**Step 1: Replace Gemini with getLLM()**

Remove:
- Line 1: `import { GoogleGenerativeAI } from "@google/generative-ai";`
- Lines 75-82: `geminiModel` variable and `getModel()` function

Add at top:
```typescript
import { getLLM } from "./providers/llm";
```

Replace lines 92-100 (the model.generateContent call + response parsing) in `extractEvents()` with:
```typescript
    const parsed = await getLLM().generateJSON<any[]>(prompt);
```

Remove the JSON stripping code (lines 97-102) since `generateJSON` handles that.

Keep the rest of the function (array validation, source text attachment, category validation).

Update the error message on line 137 from `"[extractor] Error calling Gemini API:"` to `"[extractor] Error calling LLM API:"`.

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/extractor.ts
git commit -m "refactor: extractor.ts uses LLM provider abstraction"
```

---

### Task 8: Refactor verifier.ts to use LLM provider

This file has 6 separate Gemini calls. All need updating.

**Files:**
- Modify: `src/verifier.ts`

**Step 1: Replace imports and rate limiting**

Remove:
- Line 1: `import { GoogleGenerativeAI, GenerateContentResult } from "@google/generative-ai";`
- Lines 6-13: `geminiModel` and `getModel()`
- Lines 15-47: `lastGeminiCall`, `MIN_GEMINI_INTERVAL`, and `rateLimitedGemini()` — rate limiting is now internal to each provider

Add at top:
```typescript
import { getLLM } from "./providers/llm";
```

**Step 2: Update verifyFromPage() (line 164)**

Replace the try block (lines 211-234). Instead of calling `rateLimitedGemini(prompt)` and manually parsing JSON:
```typescript
const parsed = await getLLM().generateJSON<any>(prompt);
```
Remove the JSON stripping code.

**Step 3: Update verifyFromSourceText() (line 305)**

Same pattern: replace `rateLimitedGemini(prompt)` + JSON parsing with:
```typescript
const parsed = await getLLM().generateJSON<any>(prompt);
```

**Step 4: Update verifyStoredEventUrl() (line 380)**

Same pattern at line 434: replace `rateLimitedGemini(prompt)` + JSON parsing with:
```typescript
const parsed = await getLLM().generateJSON<any>(prompt);
```

**Step 5: Update findDuplicatesAI() (line 530)**

At line 544: replace `rateLimitedGemini(prompt)` + JSON parsing with:
```typescript
const parsed = await getLLM().generateJSON<number[][]>(prompt);
if (Array.isArray(parsed)) return parsed.filter((g: any) => Array.isArray(g) && g.length >= 2);
```

**Step 6: Update searchEventsAI() (line 642)**

At line 667: replace `rateLimitedGemini(prompt)` + JSON parsing with:
```typescript
const parsed = await getLLM().generateJSON<any[]>(prompt);
```

**Step 7: Update checkLocationNYC() (line 690)**

At line 703: replace `rateLimitedGemini(prompt)` with:
```typescript
const text = await getLLM().generateText(prompt);
```

**Step 8: Update all error log messages from "Gemini" to "LLM"**

**Step 9: Verify it compiles**

Run: `npx tsc --noEmit`

**Step 10: Commit**

```bash
git add src/verifier.ts
git commit -m "refactor: verifier.ts uses LLM provider abstraction (6 call sites)"
```

---

### Task 9: Refactor relationship analyzer.ts

**Files:**
- Modify: `src/apps/relationship/analyzer.ts`

**Step 1: Replace imports**

Remove lines 1-12 (`GoogleGenerativeAI` import, `getModel()` function).

Add:
```typescript
import { getLLM } from "../../providers/llm";
```

**Step 2: Update analyzeDay()**

At lines 228-231, replace:
```typescript
const model = getModel();
const result = await model.generateContent(buildAnalysisPrompt(truncated, messages.length, date));
const text = result.response.text();
const parsed = parseGeminiJson(text, progress);
```

With:
```typescript
const parsed = await getLLM().generateJSON<any>(buildAnalysisPrompt(truncated, messages.length, date));
```

**Step 3: Rename `parseGeminiJson` to `parseLLMJson` throughout the file (or remove it if all call sites use generateJSON)**

Since `parseGeminiJson` has special error recovery (stripping evidence block), keep it as a fallback parser. But the primary path should use `generateJSON`. Update references.

**Step 4: Update log messages from "Gemini" to "LLM"**

**Step 5: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/relationship/analyzer.ts
git commit -m "refactor: relationship analyzer uses LLM provider"
```

---

### Task 10: Refactor relationship updater.ts

**Files:**
- Modify: `src/apps/relationship/updater.ts`

**Step 1: Replace imports**

Remove lines 1-12 (`GoogleGenerativeAI`, `getModel()`).

Add:
```typescript
import { getLLM } from "../../providers/llm";
```

**Step 2: Update generateMultiWindowRecommendations()**

At lines 110-121, replace:
```typescript
const model = getModel();
const result = await model.generateContent(prompt);
let text = result.response.text().trim();
// ... JSON parsing ...
```

With:
```typescript
const parsed = await getLLM().generateJSON<any>(prompt);
```

Adjust the validation code below to work with the already-parsed object.

**Step 3: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/relationship/updater.ts
git commit -m "refactor: relationship updater uses LLM provider"
```

---

### Task 11: Refactor relationship routes.ts chat endpoint

This is the most complex refactor — it uses Gemini's chat API with function calling.

**Files:**
- Modify: `src/apps/relationship/routes.ts` (lines 540-681)

**Step 1: Replace the dynamic import and Gemini setup**

Remove lines 550-551 (the dynamic import of `@google/generative-ai`).

Add at top of file:
```typescript
import { getLLM } from "../../providers/llm";
```

**Step 2: Rewrite the chat endpoint**

Replace the Gemini-specific chat logic (lines 549-676) with:

```typescript
const llm = getLLM();

// Build tools array
const tools = [{
  name: "fetch_messages",
  description: "Fetch full message history for a specific date range. Use this when the user asks about conversations that happened more than 7 days ago.",
  parameters: {
    start_date: "Start date in YYYY-MM-DD format",
    end_date: "End date in YYYY-MM-DD format",
  },
}];

// Convert chat messages to LLM format (cap at 20)
const trimmed = chatMessages.slice(-20);
const llmMessages = trimmed.map((m: any) => ({
  role: m.role as "user" | "assistant",
  content: m.content,
}));

// Function-calling loop (max 3 iterations)
let response = await llm.chat(llmMessages, tools, systemPrompt);

for (let i = 0; i < 3; i++) {
  if (!response.toolCalls || response.toolCalls.length === 0) break;

  const fc = response.toolCalls[0];
  if (fc.name === "fetch_messages") {
    const { start_date, end_date } = fc.args;
    const fetchedMessages = store.getMessagesByRange(start_date, end_date);
    // ... format messages same as before ...
    const fetchedText = fetchedMessages.map(m => { /* same formatting */ }).join("\n");

    llmMessages.push({ role: "assistant", content: response.text || "[calling fetch_messages]" });
    response = await llm.chatWithToolResult(
      llmMessages, "fetch_messages",
      fetchedText || "No messages found for this date range.",
      tools, systemPrompt
    );
  } else {
    break;
  }
}

const finalResponse = response.text || "I couldn't generate a response.";
res.json({ response: finalResponse });
```

**Step 3: Remove the `config.geminiApiKey` guard at line 544**

Replace with a check that the LLM provider is configured (or just let it throw from `getLLM()`).

**Step 4: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/relationship/routes.ts
git commit -m "refactor: relationship chat uses LLM provider with tool calling"
```

---

### Task 12: Refactor metacrisis summarizer.ts

This file has 4 Gemini call sites.

**Files:**
- Modify: `src/apps/metacrisis/summarizer.ts`

**Step 1: Replace imports**

Remove lines 1-13 (`GoogleGenerativeAI`, `getModel()`).

Add:
```typescript
import { getLLM } from "../../providers/llm";
```

**Step 2: Update runDailyDigest() (line 99)**

Replace lines 114-117:
```typescript
const model = getModel();
const result = await model.generateContent(buildDailyDigestPrompt(...));
const text = result.response.text();
const parsed = parseGeminiJson(text);
```
With:
```typescript
const parsed = await getLLM().generateJSON<any>(buildDailyDigestPrompt(truncated, messages.length, yesterday));
```

**Step 3: Update runWeeklySummary() (line 179)**

Same pattern at lines 209-212.

**Step 4: Update extractEventDetails() (line 264)**

At lines 269-294: replace `const model = getModel()` + `model.generateContent(...)` with:
```typescript
const parsed = await getLLM().generateJSON<any>(prompt);
return parsed;
```

**Step 5: Update scrapeLinksMeta() (line 357)**

At lines 405-443: replace `const model = getModel()` + `model.generateContent(...)` with:
```typescript
const parsed = await getLLM().generateJSON<any>(prompt);
```

**Step 6: Update scrapeUrlForQuickShare() (line 727)**

At lines 760-790: same pattern.

**Step 7: Remove the `parseGeminiJson()` helper function** (line 47-55) since `generateJSON` handles it. Or rename to `parseLLMJson` if still used as fallback.

**Step 8: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/metacrisis/summarizer.ts
git commit -m "refactor: metacrisis summarizer uses LLM provider (5 call sites)"
```

---

### Task 13: Refactor friends tagger.ts

3 Gemini call sites.

**Files:**
- Modify: `src/apps/friends/tagger.ts`

**Step 1: Replace imports**

Remove line 1 (`GoogleGenerativeAI`).

Add:
```typescript
import { getLLM } from "../../providers/llm";
```

**Step 2: Update runTagExtraction() (line 73)**

Remove lines 83-84 (creating `genAI` and `model`).
Replace line 95:
```typescript
const result = await model.generateContent(TAG_PROMPT + messageText);
const text = result.response.text();
```
With:
```typescript
const text = await getLLM().generateText(TAG_PROMPT + messageText);
```

**Step 3: Update runDirectTagExtraction() (line 119)**

Remove lines 143-144 (creating `genAI` and `model`).
Replace line 184:
```typescript
const result = await model.generateContent(TAG_PROMPT + messageText);
const text = result.response.text();
```
With:
```typescript
const text = await getLLM().generateText(TAG_PROMPT + messageText);
```

**Step 4: Update runTagConsolidation() (line 236)**

Remove lines 245-246 (creating `genAI` and `model`).
Replace line 270:
```typescript
const result = await model.generateContent(CONSOLIDATE_PROMPT + tagList);
const text = result.response.text();
```
With:
```typescript
const text = await getLLM().generateText(CONSOLIDATE_PROMPT + tagList);
```

**Step 5: Update all `config.geminiApiKey` guards to check provider availability**

Replace `if (!config.geminiApiKey)` with a try-catch around `getLLM()` or check `resolveProvider()`.

**Step 6: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/friends/tagger.ts
git commit -m "refactor: friends tagger uses LLM provider (3 call sites)"
```

---

### Task 14: Create transcription provider interface and factory

**Files:**
- Create: `src/providers/transcription/types.ts`
- Create: `src/providers/transcription/groq-whisper.ts`
- Create: `src/providers/transcription/assemblyai.ts`
- Create: `src/providers/transcription/index.ts`

**Step 1: Create types**

```typescript
// src/providers/transcription/types.ts
export interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface SpeakerTranscript {
  text: string;
  utterances: Utterance[];
  duration?: number;
}

export interface TranscriptionProvider {
  /** Transcribe audio to plain text (no speaker labels) */
  transcribe(audioBase64: string, mimetype: string): Promise<string>;

  /** Whether this provider supports speaker diarization */
  supportsSpeakerDiarization: boolean;

  /** Transcribe audio with speaker labels. Throws if not supported. */
  transcribeWithSpeakers(audioBuffer: Buffer, mimetype: string): Promise<SpeakerTranscript>;
}
```

**Step 2: Create Groq Whisper adapter**

Extract existing logic from `src/utils/transcription.ts`:

```typescript
// src/providers/transcription/groq-whisper.ts
import { TranscriptionProvider, SpeakerTranscript } from "./types";

export class GroqWhisperProvider implements TranscriptionProvider {
  private apiKey: string;
  supportsSpeakerDiarization = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(audioBase64: string, mimetype: string): Promise<string> {
    const buffer = Buffer.from(audioBase64, "base64");
    const blob = new Blob([buffer], { type: mimetype || "audio/ogg" });

    const form = new FormData();
    form.append("file", blob, "voice.ogg");
    form.append("model", "whisper-large-v3");
    form.append("response_format", "text");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Groq transcription failed (${res.status}): ${errText}`);
    }

    return (await res.text()).trim();
  }

  async transcribeWithSpeakers(_buffer: Buffer, _mimetype: string): Promise<SpeakerTranscript> {
    throw new Error("Groq Whisper does not support speaker diarization. Use AssemblyAI for speaker-labeled transcription.");
  }
}
```

**Step 3: Create AssemblyAI adapter**

```typescript
// src/providers/transcription/assemblyai.ts
import { AssemblyAI } from "assemblyai";
import { TranscriptionProvider, SpeakerTranscript } from "./types";

export class AssemblyAIProvider implements TranscriptionProvider {
  private client: AssemblyAI;
  supportsSpeakerDiarization = true;

  constructor(apiKey: string) {
    this.client = new AssemblyAI({ apiKey });
  }

  async transcribe(audioBase64: string, mimetype: string): Promise<string> {
    const buffer = Buffer.from(audioBase64, "base64");
    const uploadUrl = await this.client.files.upload(buffer);
    const transcript = await this.client.transcripts.transcribe({
      audio_url: uploadUrl,
      speech_models: ["universal-3-pro"],
    });
    if (transcript.status === "error") throw new Error(transcript.error || "Transcription failed");
    return transcript.text || "";
  }

  async transcribeWithSpeakers(audioBuffer: Buffer, _mimetype: string): Promise<SpeakerTranscript> {
    const uploadUrl = await this.client.files.upload(audioBuffer);
    const transcript = await this.client.transcripts.transcribe({
      audio_url: uploadUrl,
      speaker_labels: true,
      speech_models: ["universal-3-pro"],
    });
    if (transcript.status === "error") throw new Error(transcript.error || "Transcription failed");
    return {
      text: transcript.text || "",
      utterances: (transcript.utterances || []).map(u => ({
        speaker: u.speaker,
        text: u.text,
        start: u.start,
        end: u.end,
      })),
      duration: transcript.audio_duration || 0,
    };
  }
}
```

**Step 4: Create factory**

```typescript
// src/providers/transcription/index.ts
import { TranscriptionProvider } from "./types";
import { config } from "../../config";

let cachedProvider: TranscriptionProvider | null = null;
let cachedSpeakerProvider: TranscriptionProvider | null = null;

/** Get the transcription provider for simple voice-to-text */
export function getTranscriber(): TranscriptionProvider {
  if (cachedProvider) return cachedProvider;

  const provider = config.transcriptionProvider || (config.groqApiKey ? "groq" : config.assemblyAiApiKey ? "assemblyai" : "");

  switch (provider) {
    case "groq": {
      const { GroqWhisperProvider } = require("./groq-whisper");
      cachedProvider = new GroqWhisperProvider(config.groqApiKey);
      break;
    }
    case "assemblyai": {
      const { AssemblyAIProvider } = require("./assemblyai");
      cachedProvider = new AssemblyAIProvider(config.assemblyAiApiKey);
      break;
    }
    default:
      throw new Error(
        "No transcription provider configured. Set TRANSCRIPTION_PROVIDER and the corresponding API key.\n" +
        "Options: groq (GROQ_API_KEY), assemblyai (ASSEMBLYAI_API_KEY)"
      );
  }

  console.log(`[transcription] Using provider: ${provider}`);
  return cachedProvider;
}

/** Get a provider that supports speaker diarization (for recordings/calls) */
export function getSpeakerTranscriber(): TranscriptionProvider {
  if (cachedSpeakerProvider) return cachedSpeakerProvider;

  // Prefer AssemblyAI for speaker diarization
  if (config.assemblyAiApiKey) {
    const { AssemblyAIProvider } = require("./assemblyai");
    cachedSpeakerProvider = new AssemblyAIProvider(config.assemblyAiApiKey);
    console.log("[transcription] Using AssemblyAI for speaker diarization");
    return cachedSpeakerProvider;
  }

  // Fall back to the configured provider (may not support speakers)
  cachedSpeakerProvider = getTranscriber();
  return cachedSpeakerProvider;
}

export { TranscriptionProvider } from "./types";
```

**Step 5: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/providers/transcription/
git commit -m "feat: add transcription provider abstraction (Groq, AssemblyAI)"
```

---

### Task 15: Refactor transcription call sites

**Files:**
- Modify: `src/utils/transcription.ts`
- Modify: `src/apps/recording/routes.ts`
- Modify: `src/apps/calls/routes.ts`

**Step 1: Rewrite src/utils/transcription.ts**

Replace the entire file with a thin wrapper around the provider:

```typescript
import { getTranscriber } from "../providers/transcription";

export async function transcribeVoiceNote(base64Data: string, mimetype: string): Promise<string> {
  try {
    return await getTranscriber().transcribe(base64Data, mimetype);
  } catch (err: any) {
    if (err?.message?.includes("No transcription provider")) {
      console.log("[transcription] No provider configured, skipping voice transcription");
      return "";
    }
    throw err;
  }
}
```

**Step 2: Refactor recording/routes.ts**

Remove lines 3-4 (`AssemblyAI` import), remove lines 36-46 (lazy client initialization).

Replace the transcription logic in the POST handler (lines 60-75) with:

```typescript
import { getSpeakerTranscriber } from "../../providers/transcription";

// In the handler:
const transcriber = getSpeakerTranscriber();
if (!transcriber.supportsSpeakerDiarization) {
  // Fall back to plain transcription
  const text = await transcriber.transcribe(req.file.buffer.toString("base64"), req.file.mimetype);
  res.json({ id: "local", text, utterances: [{ speaker: "A", text, start: 0, end: 0 }] });
  return;
}
const result = await transcriber.transcribeWithSpeakers(req.file.buffer, req.file.mimetype);
res.json({
  id: "transcript",
  text: result.text,
  utterances: result.utterances,
});
```

**Step 3: Refactor calls/routes.ts**

Same pattern as recording/routes.ts. Remove AssemblyAI import and lazy client, use `getSpeakerTranscriber()`.

**Step 4: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/utils/transcription.ts src/apps/recording/routes.ts src/apps/calls/routes.ts
git commit -m "refactor: transcription routes use provider abstraction"
```

---

### Task 16: Update index.ts guards and error messages

**Files:**
- Modify: `src/index.ts`

**Step 1: Update the "web-only mode" check**

At line 762, replace:
```typescript
if (!config.geminiApiKey) {
```
With:
```typescript
import { resolveProvider } from "./config";
// ...
if (!resolveProvider()) {
```

Update the message at line 764 from referencing `GEMINI_API_KEY` to referencing `LLM_PROVIDER`.

**Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/index.ts
git commit -m "refactor: index.ts uses resolveProvider() for LLM availability check"
```

---

### Task 17: Update .env.example and .env with new provider vars

**Files:**
- Modify: `.env.example`
- Modify: `.env`

**Step 1: Update .env.example**

Replace the `GEMINI_API_KEY` section with:

```
# ── LLM Provider ──
# Options: anthropic, gemini, ollama, groq
# Auto-detected from API keys if not set
LLM_PROVIDER=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# Ollama (if LLM_PROVIDER=ollama)
OLLAMA_MODEL=llama3.3
OLLAMA_URL=http://localhost:11434

# ── Transcription Provider ──
# Options: groq, assemblyai
# Auto-detected from API keys if not set
TRANSCRIPTION_PROVIDER=
```

**Step 2: Update .env with the user's Anthropic key placeholder**

Set `LLM_PROVIDER=anthropic` and add `ANTHROPIC_API_KEY=` placeholder.

**Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: update .env.example with provider configuration"
```

---

### Task 18: Add monitored_groups table for group summarizer

**Files:**
- Modify: `src/apps/metacrisis/store.ts`

**Step 1: Add monitored_groups table in initTables()**

After the existing table creation (around line 118), add:

```typescript
this.db.exec(`
  CREATE TABLE IF NOT EXISTS monitored_groups (
    chat_name TEXT PRIMARY KEY,
    announcement_chat TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);
```

**Step 2: Add query methods**

```typescript
isGroupMonitored(chatName: string): boolean {
  const row = this.db.prepare(
    `SELECT 1 FROM monitored_groups WHERE chat_name = ? AND enabled = 1`
  ).get(chatName);
  return !!row;
}

getMonitoredGroups(): Array<{ chat_name: string; announcement_chat: string; enabled: number }> {
  return this.db.prepare(
    `SELECT * FROM monitored_groups ORDER BY chat_name`
  ).all() as any[];
}

addMonitoredGroup(chatName: string, announcementChat?: string) {
  this.db.prepare(
    `INSERT OR REPLACE INTO monitored_groups (chat_name, announcement_chat) VALUES (?, ?)`
  ).run(chatName, announcementChat || "");
}

removeMonitoredGroup(chatName: string) {
  this.db.prepare(`DELETE FROM monitored_groups WHERE chat_name = ?`).run(chatName);
}
```

**Step 3: Migrate existing METACRISIS_CHAT_NAME setting**

Add to `initTables()`:
```typescript
// Migrate: if METACRISIS_CHAT_NAME is set and no groups are monitored, add it
if (config.metacrisisChatName) {
  const existing = this.db.prepare(`SELECT COUNT(*) as count FROM monitored_groups`).get() as any;
  if (existing.count === 0) {
    this.db.prepare(
      `INSERT OR IGNORE INTO monitored_groups (chat_name, announcement_chat) VALUES (?, ?)`
    ).run(config.metacrisisChatName, config.metacrisisAnnouncementChat || "");
  }
}
```

**Step 4: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/metacrisis/store.ts
git commit -m "feat: add monitored_groups table for multi-group summarizer"
```

---

### Task 19: Update metacrisis handler for multi-group monitoring

**Files:**
- Modify: `src/apps/metacrisis/handler.ts`

**Step 1: Update handler to check monitored groups**

Replace line 69:
```typescript
const chatNameLower = config.metacrisisChatName.toLowerCase();
```
With checking the store's monitored groups list.

Update line 80 and 89: instead of `chat.name.toLowerCase().includes(chatNameLower)`, use:
```typescript
store.isGroupMonitored(chat.name)
```

Remove the hard dependency on `config.metacrisisChatName`.

**Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/metacrisis/handler.ts
git commit -m "refactor: metacrisis handler monitors groups from database"
```

---

### Task 20: Add group management API endpoints

**Files:**
- Modify: `src/apps/metacrisis/routes.ts`

**Step 1: Read current routes file and add new endpoints**

Add these routes to the metacrisis router:

```typescript
// GET /api/metacrisis/groups/monitored — list monitored groups
router.get("/groups/monitored", (_req: Request, res: Response) => {
  res.json(store.getMonitoredGroups());
});

// POST /api/metacrisis/groups/monitor — add a group to monitoring
router.post("/groups/monitor", (req: Request, res: Response) => {
  const { chatName, announcementChat } = req.body;
  if (!chatName) { res.status(400).json({ error: "chatName required" }); return; }
  store.addMonitoredGroup(chatName, announcementChat);
  res.json({ ok: true, chatName });
});

// DELETE /api/metacrisis/groups/monitor — remove a group
router.delete("/groups/monitor", (req: Request, res: Response) => {
  const { chatName } = req.body;
  if (!chatName) { res.status(400).json({ error: "chatName required" }); return; }
  store.removeMonitoredGroup(chatName);
  res.json({ ok: true, chatName });
});
```

The "available groups" endpoint needs the WhatsApp client — add it via a callback from index.ts (same pattern as other WhatsApp-dependent operations).

**Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/apps/metacrisis/routes.ts
git commit -m "feat: add group management API endpoints for metacrisis"
```

---

### Task 21: Full compilation and smoke test

**Step 1: Full TypeScript compile check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Verify the app starts**

Make sure `.env` has `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` set (or any valid provider).

Run: `npm run dev`
Expected: Server starts, prints `[llm] Using provider: anthropic`, no crashes.

If no API keys are set, it should print the "web-only mode" message and still serve the web UI.

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete provider abstraction - supports Anthropic, Gemini, Ollama"
```
