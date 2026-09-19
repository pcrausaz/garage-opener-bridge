import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string, pretty = false): Logger {
  const opts: pino.LoggerOptions = {
    level,
    redact: { paths: ["*.apiKey", "*.token", "*.tokens", "req.headers.authorization", "*.thumbnail", "*.thumbnails"], censor: "[redacted]" },
  };
  if (pretty) {
    return pino({ ...opts, transport: { target: "pino-pretty", options: { colorize: true } } });
  }
  return pino(opts);
}

export const silentLogger: Logger = pino({ level: "silent" });
