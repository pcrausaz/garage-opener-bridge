import { describe, expect, it } from "vitest";
import { OutboundWebhook, sign, verify } from "../../src/notify/webhook.js";
import { silentLogger } from "../../src/logger.js";
import { Bus } from "../../src/events/bus.js";

describe("HMAC outbound events", () => {
  it("signs and verifies with constant-time compare", () => {
    const sig = sign("s3cret", '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verify("s3cret", '{"a":1}', sig)).toBe(true);
    expect(verify("s3cret", '{"a":2}', sig)).toBe(false);
    expect(verify("other", '{"a":1}', sig)).toBe(false);
    expect(verify("s3cret", '{"a":1}', undefined)).toBe(false);
  });

  it("posts signed envelopes for bus events and retries failures", async () => {
    const calls: { headers: Record<string, string>; body: string }[] = [];
    let fail = 1;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (fail-- > 0) return new Response("nope", { status: 500 });
      calls.push({ headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const hook = new OutboundWebhook({ url: "https://n8n.example/hook", secret: "k", logger: silentLogger, fetchImpl, retries: 2 });
    const bus = new Bus();
    hook.attach(bus);
    bus.emit("hold", { active: true, minutes: 5 });
    await hook.send("alert", { id: "x" });
    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    expect(first.headers["x-garage-event"]).toBe("hold");
    expect(verify("k", first.body, first.headers["x-garage-signature"])).toBe(true);
    const env = JSON.parse(first.body);
    expect(env).toMatchObject({ type: "hold", data: { active: true, minutes: 5 } });
    expect(env.id).toMatch(/[0-9a-f-]{36}/);
  });
});
