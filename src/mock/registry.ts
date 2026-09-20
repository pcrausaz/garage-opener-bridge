import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { Instance } from "../instance.js";

/** Mock mode: one isolated simulator per bearer token, expiring after idle. */
export class MockRegistry {
  private readonly instances = new Map<string, Promise<Instance>>();
  /** Claimed member tokens → the token whose instance issued the invite. */
  private readonly aliases = new Map<string, string>();
  private sweeper: NodeJS.Timeout | null = null;
  constructor(private readonly config: Config, private readonly logger: Logger) {}

  start(): void {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  alias(memberToken: string, ownerToken: string): void {
    this.aliases.set(memberToken, this.aliases.get(ownerToken) ?? ownerToken);
  }

  /** Find the instance holding an unclaimed invite code (mock mode has many instances). */
  async findByInvite(code: string): Promise<{ token: string; inst: Instance } | null> {
    for (const [token, p] of this.instances) {
      const inst = await p.catch(() => null);
      if (inst?.members.hasInvite(code)) return { token, inst };
    }
    return null;
  }

  async get(rawToken: string): Promise<Instance> {
    const token = this.aliases.get(rawToken) ?? rawToken;
    let p = this.instances.get(token);
    if (!p) {
      p = (async () => {
        const inst = new Instance(this.config, this.logger, "mock", { label: `mock:${token.slice(0, 6)}…` });
        await inst.start();
        return inst;
      })();
      this.instances.set(token, p);
      p.catch(() => this.instances.delete(token));
    }
    const inst = await p;
    inst.touch();
    return inst;
  }

  size(): number {
    return this.instances.size;
  }

  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.config.bridge.mockIdleMinutes * 60_000;
    for (const [token, p] of this.instances) {
      const inst = await p.catch(() => null);
      if (!inst) continue;
      if (now - inst.lastTouched > idleMs) {
        this.instances.delete(token);
        for (const [k, v] of this.aliases) if (v === token) this.aliases.delete(k);
        await inst.stop();
        this.logger.info({ token: token.slice(0, 6) + "…" }, "mock instance expired");
      }
    }
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const p of this.instances.values()) await (await p.catch(() => null))?.stop();
    this.instances.clear();
  }
}
