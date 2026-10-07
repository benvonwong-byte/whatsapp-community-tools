import { randomUUID } from "crypto";
import { log } from "./log";

export class SignalCliError extends Error {
  constructor(message: string, public code?: number, public data?: unknown) {
    super(message);
    this.name = "SignalCliError";
  }
}

export interface SendResult {
  timestamp: number;
  results?: Array<{
    recipientAddress?: { uuid?: string | null; number?: string | null; username?: string | null };
    groupId?: string;
    type?: string;
  }>;
}

export interface EventSubscription {
  close(): void;
}

interface SubscribeOptions {
  lastEventId?: string;
  onEvent: (payload: any, eventId: string | undefined) => void;
  onConnect?: () => void;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// signal-cli sends an SSE keep-alive every 15s by default; treat a longer silence as a dead stream.
const STALL_TIMEOUT_MS = 60000;

/**
 * Client for a signal-cli daemon started with `--http`.
 * See `man signal-cli-jsonrpc` for the protocol.
 */
export class SignalCliClient {
  constructor(private baseUrl: string, private account?: string) {}

  setAccount(account: string) {
    this.account = account;
  }

  async rpc<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { withAccount?: boolean } = {}
  ): Promise<T> {
    // Single-account daemons ignore `account`; multi-account daemons require it for per-account methods.
    const withAccount = (opts.withAccount ?? true) && this.account;
    const body = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params: withAccount ? { account: this.account, ...params } : params,
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      throw new SignalCliError(
        `Could not reach signal-cli at ${this.baseUrl} (${err?.cause?.code || err?.message}). ` +
          `Is \`signal-cli daemon --http\` running?`
      );
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SignalCliError(`signal-cli returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (json.error) {
      let message = json.error.message || "signal-cli error";
      if (json.error.code === -32602 && /account/i.test(message)) {
        message += ". Set SIGNAL_ACCOUNT to a number linked in signal-cli (see `signal-cli listAccounts`).";
      }
      throw new SignalCliError(message, json.error.code, json.error.data);
    }
    return json.result as T;
  }

  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/check`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Follow the daemon's Server-Sent Events stream, reconnecting with backoff.
   * Passing the last seen event id lets signal-cli replay events missed while disconnected.
   */
  subscribe(opts: SubscribeOptions): EventSubscription {
    let closed = false;
    let lastEventId = opts.lastEventId;
    let controller: AbortController | null = null;
    let delay = RECONNECT_MIN_MS;

    const run = async () => {
      while (!closed) {
        controller = new AbortController();
        let stallTimer: NodeJS.Timeout | null = null;
        const resetStall = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => controller?.abort(), STALL_TIMEOUT_MS);
        };
        try {
          const url = new URL(`${this.baseUrl}/api/v1/events`);
          if (this.account) url.searchParams.set("account", this.account);
          const headers: Record<string, string> = { Accept: "text/event-stream" };
          if (lastEventId) headers["Last-Event-ID"] = lastEventId;

          resetStall();
          const res = await fetch(url, { headers, signal: controller.signal });
          if (res.status === 400 && this.account) {
            throw new Error(`HTTP 400: signal-cli has no linked account ${this.account}`);
          }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          log(`Connected to signal-cli event stream at ${this.baseUrl}`);
          delay = RECONNECT_MIN_MS;
          opts.onConnect?.();

          await parseSse(res.body, resetStall, (event) => {
            if (event.id) lastEventId = event.id;
            if (event.event && event.event !== "receive") return;
            let payload: any;
            try {
              payload = JSON.parse(event.data);
            } catch {
              log("Ignoring unparseable event:", event.data.slice(0, 200));
              return;
            }
            try {
              opts.onEvent(payload, event.id);
            } catch (err) {
              log("Error handling event:", err);
            }
          });
          if (!closed) log("signal-cli event stream ended; reconnecting");
        } catch (err: any) {
          if (closed) break;
          log(`signal-cli event stream unavailable (${err?.cause?.code || err?.message}); retrying in ${delay / 1000}s`);
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
        }
        if (closed) break;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    };
    void run();

    return {
      close() {
        closed = true;
        controller?.abort();
      },
    };
  }
}

interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

async function parseSse(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
  onEvent: (e: SseEvent) => void
) {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    onActivity();
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);

      if (line === "") {
        if (data.length > 0) onEvent({ id, event, data: data.join("\n") });
        id = undefined;
        event = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue; // keep-alive comment

      const colon = line.indexOf(":");
      const field = colon >= 0 ? line.slice(0, colon) : line;
      let value = colon >= 0 ? line.slice(colon + 1) : "";
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
}
