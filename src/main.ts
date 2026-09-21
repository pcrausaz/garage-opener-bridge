import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Instance, startWithRetry } from "./instance.js";
import { MockRegistry } from "./mock/registry.js";
import { buildServer } from "./http/server.js";
import { VERSION } from "./version.js";
import { installId, startBonjour } from "./bonjour.js";
import { printPairingInvite } from "./pairing.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.logPretty);
  logger.info({ version: VERSION, mode: config.bridge.mode }, "garage-opener bridge starting");
  let instance: Instance | undefined;
  let registry: MockRegistry | undefined;
  let stopping = false;
  if (config.bridge.mode === "mock") {
    registry = new MockRegistry(config, logger);
    registry.start();
  } else {
    instance = new Instance(config, logger, "live"); // config errors throw here → exit 1 (needs a redeploy)
  }
  const app = await buildServer({ config, logger, instance, registry });
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, "listening");
  // Deliberately before the console handshake: pairing only needs the local member store, so the link is
  // there to copy even while Protect is still unreachable and /healthz reports ready:false.
  if (instance) printPairingInvite(instance, config, logger);
  // Live mode: discovery/console problems must not take the port down; /healthz reports ready:false meanwhile.
  if (instance) void startWithRetry(instance, logger, { stopped: () => stopping });
  const bonjourOn = config.bonjour ?? config.bridge.mode === "live";
  let stopBonjour: (() => Promise<void>) | null = null;
  if (bonjourOn) {
    const id = instance ? installId(instance.store) : "mock";
    try {
      stopBonjour = startBonjour({ port: config.port, version: VERSION, mode: config.bridge.mode, id, logger, ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}) });
    } catch (err) {
      logger.warn({ err }, "bonjour unavailable (needs host networking under Docker)");
    }
  }
  const shutdown = async (signal: string) => {
    stopping = true;
    logger.info({ signal }, "shutting down");
    await stopBonjour?.();
    await app.close();
    await instance?.stop();
    await registry?.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
