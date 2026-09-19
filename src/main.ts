import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Instance } from "./instance.js";
import { MockRegistry } from "./mock/registry.js";
import { buildServer } from "./http/server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.logPretty);
  logger.info({ version: VERSION, mode: config.bridge.mode }, "garage-opener bridge starting");
  let instance: Instance | undefined;
  let registry: MockRegistry | undefined;
  if (config.bridge.mode === "mock") {
    registry = new MockRegistry(config, logger);
    registry.start();
  } else {
    instance = new Instance(config, logger, "live");
    await instance.start();
  }
  const app = await buildServer({ config, logger, instance, registry });
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, "listening");
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
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
