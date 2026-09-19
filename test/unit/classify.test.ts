import { describe, expect, it } from "vitest";
import { classifyAlarmPayload, deviceMatches, normalizePlate, stripThumbnails } from "../../src/webhooks/classify.js";
import { loadFixture } from "../protect-mock-server.js";

const fx = (n: string) => loadFixture<unknown>(`alarm-manager/${n}`);

describe("alarm manager classifier", () => {
  it("classifies synthetic fixtures", () => {
    expect(classifyAlarmPayload(fx("synthetic-sensor-opened.json"))[0]).toMatchObject({ type: "opened", device: "F4E2C6AABBCC", at: 1758300000000 });
    expect(classifyAlarmPayload(fx("synthetic-sensor-closed.json"))[0]?.type).toBe("closed");
    expect(classifyAlarmPayload(fx("synthetic-vehicle-detected.json"))[0]).toMatchObject({ type: "vehicle-start", device: "650b2b3c03738b03e4013954" });
    expect(classifyAlarmPayload(fx("synthetic-vehicle-ended.json"))[0]?.type).toBe("vehicle-end");
    expect(classifyAlarmPayload(fx("synthetic-plate-seen.json"))[0]).toMatchObject({ type: "plate", plate: "ABC123", device: "64dd4c4303e52b03e4008041" });
  });

  it("handles GET pings via query and seconds-precision timestamps", () => {
    const [e] = classifyAlarmPayload(undefined, { event: "closed", device: "abc" }, 5);
    expect(e).toMatchObject({ type: "closed", device: "abc", at: 5 });
    expect(classifyAlarmPayload({ timestamp: 1758300000, alarm: { triggers: [{ key: "sensor_opened" }] } })[0]?.at).toBe(1758300000000);
  });

  it("degrades unknown shapes to unknown", () => {
    expect(classifyAlarmPayload({ hello: "world" })[0]?.type).toBe("unknown");
    expect(classifyAlarmPayload("garbage")[0]?.type).toBe("unknown");
    expect(classifyAlarmPayload({ alarm: { name: "Garage door opened" } })[0]?.type).toBe("opened");
  });

  it("strips thumbnails before logging", () => {
    const out = stripThumbnails(fx("synthetic-vehicle-detected.json")) as { alarm: { thumbnail: string; triggers: unknown[] } };
    expect(out.alarm.thumbnail).toBe("[stripped]");
    expect(out.alarm.triggers).toHaveLength(1);
    expect((stripThumbnails({ x: "a".repeat(5000) }) as { x: string }).x).toBe("[stripped]");
  });

  it("normalizes plates and matches devices loosely", () => {
    expect(normalizePlate(" ab-c 123 ")).toBe("ABC123");
    expect(deviceMatches("f4:e2:c6:aa:bb:cc", "F4E2C6AABBCC")).toBe(true);
    expect(deviceMatches("x", null, undefined, "y")).toBe(false);
  });
});
