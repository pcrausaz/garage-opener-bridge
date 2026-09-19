import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { Instance } from "../instance.js";

/** Mock mode: one isolated simulator per bearer token, expiring after idle. */
export class MockRegistry {
  private readonly instances = new Map<string, Promise<Instance>>();
  private sweeper: NodeJS.Timeout | null = null;
  constructor(private readonly config: Config, private readonly logger: Logger) {}

  start(): void {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  async get(token: string): Promise<Instance> {
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
