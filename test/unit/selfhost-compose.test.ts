import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ENV_MAP } from "../../src/config.js";

// Stack managers (Dockhand, Portainer) pass only what the compose file references, so a setting missing from
// `environment:` silently never reaches the bridge. Keep the reference compose in step with ENV_MAP.
const compose = parseYaml(readFileSync(new URL("../../selfhost/docker-compose.yml", import.meta.url), "utf8")) as {
  services: Record<string, { environment?: Record<string, string> }>;
};
const bridgeEnv = compose.services.bridge!.environment ?? {};

/** Development, test and mock-only settings a self-hoster never needs. */
const INTERNAL = new Set(["HOST", "LOG_PRETTY", "VALIDATE_RESPONSES", "MOCK_TOKEN_PREFIX", "MOCK_IDLE_MINUTES"]);

describe("selfhost/docker-compose.yml", () => {
  it("lists every self-hosting setting under the bridge's environment", () => {
    const missing = Object.keys(ENV_MAP).filter((k) => !INTERNAL.has(k) && !(k in bridgeEnv));
    expect(missing).toEqual([]);
  });

  it("uses no env_file, so it works as a pasted stack", () => {
    expect(readFileSync(new URL("../../selfhost/docker-compose.yml", import.meta.url), "utf8")).not.toMatch(/^\s*env_file:/m);
  });

  it("requires nothing from a profile-gated service, since compose interpolates every service", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      if (!(svc as { profiles?: string[] }).profiles) continue;
      for (const v of Object.values(svc.environment ?? {})) expect(String(v), `${name}`).not.toMatch(/:\?/);
    }
  });
});
