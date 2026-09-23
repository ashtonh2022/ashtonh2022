import { DEFAULT_TRUST_PROXY } from './clientIp';
import { DEFAULT_MAX_ROOM_CREATES_PER_IP, DEFAULT_MAX_ROOMS } from './hub';
import { DEFAULT_MAX_CONNECTIONS_PER_IP } from './server';

/** The server's settings from the environment (see docs/DEPLOY.md). */
export interface EnvConfig {
  port: number;
  host: string;
  roomTtlMinutes: number;
  maxRooms: number;
  trustProxy: number;
  maxConnectionsPerIp: number;
  maxRoomCreatesPerIp: number;
}

/** Settings that cannot be used. The message names each variable and what it should be. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

interface NumberRule {
  fallback: number;
  /** what the variable must be, for the error message */
  expected: string;
  valid(value: number): boolean;
}

const wholeAtLeast = (min: number) => (value: number) => Number.isInteger(value) && value >= min;

/**
 * Reads the settings from `env`. An unset or blank variable takes its default; any other value
 * that does not fit throws a ConfigError naming every bad variable, rather than being replaced by
 * the default: `TRUST_PROXY=true` read as 0 would quietly put everyone behind the proxy under one
 * address, and `MAX_CONNECTIONS_PER_IP=off` read as 20 would quietly keep the limit.
 */
export function readConfig(env: Env): EnvConfig {
  const problems: string[] = [];
  const number = (name: string, rule: NumberRule): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return rule.fallback;
    const value = Number(raw.trim());
    if (rule.valid(value)) return value;
    problems.push(`${name} must be ${rule.expected}, not ${JSON.stringify(raw)}`);
    return rule.fallback;
  };
  const config: EnvConfig = {
    port: number('PORT', {
      fallback: 8080,
      expected: 'a port number from 0 to 65535',
      valid: (value) => wholeAtLeast(0)(value) && value <= 65535,
    }),
    host: env['HOST']?.trim() || '0.0.0.0',
    roomTtlMinutes: number('ROOM_TTL_MINUTES', {
      fallback: 120,
      expected: 'a number of minutes above 0',
      valid: (value) => Number.isFinite(value) && value > 0,
    }),
    maxRooms: number('MAX_ROOMS', {
      fallback: DEFAULT_MAX_ROOMS,
      expected: 'a whole number of 1 or more',
      valid: wholeAtLeast(1),
    }),
    trustProxy: number('TRUST_PROXY', {
      fallback: DEFAULT_TRUST_PROXY,
      expected:
        'the number of reverse proxies in front of the server, a whole number of 0 or more ' +
        '(1 on Fly.io, Railway and Render; see docs/DEPLOY.md)',
      valid: wholeAtLeast(0),
    }),
    maxConnectionsPerIp: number('MAX_CONNECTIONS_PER_IP', {
      fallback: DEFAULT_MAX_CONNECTIONS_PER_IP,
      expected: 'a whole number of 1 or more',
      valid: wholeAtLeast(1),
    }),
    maxRoomCreatesPerIp: number('MAX_ROOM_CREATES_PER_IP', {
      fallback: DEFAULT_MAX_ROOM_CREATES_PER_IP,
      expected: 'a whole number of 1 or more',
      valid: wholeAtLeast(1),
    }),
  };
  if (problems.length > 0) throw new ConfigError(problems.join('\n'));
  return config;
}
