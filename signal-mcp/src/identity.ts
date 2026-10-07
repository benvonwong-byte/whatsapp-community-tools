import { config } from "./config";
import { SELF, SignalStore, UUID_RE } from "./store";

/**
 * The account owner's Signal identifiers (ACI and number), learned from config, signal-cli,
 * or Signal Desktop and shared by every message source so "self" is recognised consistently.
 */
export class Identity {
  uuid?: string;
  number?: string;

  constructor(private store: SignalStore) {
    this.learn(store.getMeta("self_uuid"), store.getMeta("self_number"));
    if (config.account) this.learnAccount(config.account);
  }

  /** An account identifier as signal-cli reports it: a phone number or an ACI. */
  learnAccount(account: string) {
    if (account.startsWith("+")) this.learn(undefined, account);
    else if (UUID_RE.test(account)) this.learn(account, undefined);
  }

  learn(uuid?: string | null, number?: string | null) {
    if (uuid && uuid !== this.uuid) {
      this.uuid = uuid;
      this.store.setMeta("self_uuid", uuid);
    }
    if (number && number !== this.number) {
      this.number = number;
      this.store.setMeta("self_number", number);
    }
  }

  isSelf(uuid?: string | null, number?: string | null): boolean {
    return Boolean((uuid && uuid === this.uuid) || (number && number === this.number));
  }

  /** Canonical id for an address: SELF for the account owner, otherwise ACI, falling back to number. */
  idFor(uuid?: string | null, number?: string | null): string | null {
    if (this.isSelf(uuid, number)) return SELF;
    return uuid || number || null;
  }

  /** Own ACI (preferred) or number, for RPC params that need an author address. */
  address(): string | undefined {
    return this.uuid || this.number || config.account;
  }
}
