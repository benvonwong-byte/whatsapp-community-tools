import http from "http";
import { AddressInfo } from "net";

export const SELF_NUMBER = "+15550000000";
export const SELF_UUID = "00000000-0000-4000-8000-000000000000";
export const ALICE = { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", number: "+15551111111" };
export const BOB = { uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", number: "+15552222222" };
export const CAROL = { uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", number: null };
export const GROUP_ID = "Pmpi+EfPWmsxiomLe9Nx2XF9HOE483p6iKiFj65iMwI=";

/**
 * A stand-in for `signal-cli daemon --http`: JSON-RPC on /api/v1/rpc and SSE on /api/v1/events,
 * with payload shapes taken from signal-cli's Json* records.
 */
export class MockSignalCli {
  calls: Array<{ method: string; params: any }> = [];
  lastEventIdHeaders: Array<string | undefined> = [];
  attachments: Record<string, Buffer> = {};
  private server: http.Server;
  private clients: http.ServerResponse[] = [];
  private seq = 0;
  private clientWaiters: Array<() => void> = [];

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    for (const c of this.clients) c.end();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get connectedClients() {
    return this.clients.length;
  }

  waitForClients(n = 1): Promise<void> {
    if (this.clients.length >= n) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => (this.clients.length >= n ? resolve() : this.clientWaiters.push(check));
      this.clientWaiters.push(check);
    });
  }

  /** Emit a receive event exactly like signal-cli's SseEventBuffer. */
  push(envelope: any) {
    const id = `1700000000000-${++this.seq}`;
    const data = JSON.stringify({ account: SELF_NUMBER, envelope });
    for (const c of this.clients) c.write(`id:${id}\nevent:receive\ndata:${data}\n\n`);
  }

  dropClients() {
    for (const c of this.clients) c.destroy();
    this.clients = [];
  }

  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === "GET" && req.url?.startsWith("/api/v1/events")) {
      this.lastEventIdHeaders.push(req.headers["last-event-id"] as string | undefined);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":\n");
      this.clients.push(res);
      req.on("close", () => (this.clients = this.clients.filter((c) => c !== res)));
      const waiters = this.clientWaiters.splice(0);
      waiters.forEach((w) => w());
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/check") {
      res.writeHead(200).end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/rpc") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const request = JSON.parse(body);
        this.calls.push({ method: request.method, params: request.params });
        const reply = (payload: object) =>
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...payload }));
        try {
          reply({ result: this.rpc(request.method, request.params ?? {}) });
        } catch (err: any) {
          reply({ error: { code: err.code ?? -1, message: err.message } });
        }
      });
      return;
    }
    res.writeHead(404).end();
  }

  private rpc(method: string, params: any): any {
    const sendResult = (recipients: Array<{ uuid: string | null; number: string | null }>) => ({
      timestamp: Date.now() + this.calls.length,
      results: recipients.map((r) => ({ recipientAddress: r, type: "SUCCESS" })),
    });
    switch (method) {
      case "listAccounts":
        throw Object.assign(new Error("Method not implemented"), { code: -32601 });
      case "getUserStatus":
        return [{ recipient: SELF_NUMBER, number: SELF_NUMBER, uuid: SELF_UUID, isRegistered: true }];
      case "listContacts":
        return [
          { ...ALICE, username: null, name: "Alice Smith", nickName: null, givenName: "Alice", familyName: "Smith", isBlocked: false, profile: { givenName: "Ali", familyName: null } },
          { ...BOB, username: "bob.42", name: null, nickName: null, givenName: null, familyName: null, isBlocked: false, profile: { givenName: "Bob", familyName: "Jones" } },
          { uuid: SELF_UUID, number: SELF_NUMBER, name: "Me myself", profile: null },
        ];
      case "listGroups":
        return [
          {
            id: GROUP_ID,
            name: "Book Club",
            isMember: true,
            isBlocked: false,
            members: [
              { ...ALICE, isAdmin: true },
              { ...BOB, isAdmin: false },
              { uuid: SELF_UUID, number: SELF_NUMBER, isAdmin: false },
            ],
          },
        ];
      case "send": {
        if (params.groupId) return sendResult([ALICE, BOB]);
        if (params.noteToSelf) return sendResult([{ uuid: SELF_UUID, number: SELF_NUMBER }]);
        const to = params.recipient[0];
        const known = [ALICE, BOB, CAROL].find((c) => c.uuid === to || c.number === to);
        return sendResult([known ?? { uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", number: to }]);
      }
      case "sendReaction":
        return { timestamp: Date.now(), results: [] };
      case "getAttachment": {
        const data = this.attachments[params.id];
        if (!data) throw new Error(`Could not find attachment with ID: ${params.id}`);
        return { data: data.toString("base64") };
      }
      default:
        throw Object.assign(new Error("Method not implemented"), { code: -32601 });
    }
  }
}
