import pino from "pino";

export type Logger = pino.Logger;

/** Fields that may carry a phone number, an Apple ID, or exact coordinates. Never logged. */
export const REDACTED_PATHS = [
  "senderId",
  "*.senderId",
  "phone",
  "*.phone",
  "latitude",
  "longitude",
  "*.latitude",
  "*.longitude",
  "origin",
  "*.origin",
  "text",
  "*.text",
];

export function createLogger(options: { level?: string; destination?: pino.DestinationStream } = {}): Logger {
  return pino(
    { level: options.level ?? "info", redact: { paths: REDACTED_PATHS, censor: "[redacted]" } },
    options.destination,
  );
}

export const silentLogger: Logger = pino({ level: "silent" });
