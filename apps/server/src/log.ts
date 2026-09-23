export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

function stamp(): string {
  return new Date().toISOString();
}

export const consoleLogger: Logger = {
  info: (message, ...details) => console.log(`${stamp()} info  ${message}`, ...details),
  warn: (message, ...details) => console.warn(`${stamp()} warn  ${message}`, ...details),
  error: (message, ...details) => console.error(`${stamp()} error ${message}`, ...details),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
