import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, readConfig } from './config';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT_VARIABLES = [
  'TRUST_PROXY',
  'MAX_CONNECTIONS_PER_IP',
  'MAX_ROOM_CREATES_PER_IP',
  'MAX_ROOMS',
  'ROOM_TTL_MINUTES',
];

interface EntryRun {
  /** everything the process wrote */
  output: string;
  /** true when it got as far as listening (it is then stopped) */
  listening: boolean;
  /** exit code when it stopped by itself */
  code: number | null;
}

/** Runs a server entry point from src with tsx on a free port, until it listens or exits. */
function runEntry(entry: string, env: Record<string, string> = {}): Promise<EntryRun> {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LIMIT_VARIABLES) delete base[name];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join('src', entry)], {
      cwd: SERVER_DIR,
      env: { ...base, PORT: '0', HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let listening = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${entry} neither listened nor exited:\n${output}`));
    }, 20_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (!listening && output.includes('listening on')) {
        listening = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ output, listening, code: listening ? null : code });
    });
  });
}

describe('readConfig', () => {
  it('uses the defaults for unset and blank variables', () => {
    expect(readConfig({ TRUST_PROXY: ' ', MAX_ROOMS: '' })).toEqual({
      port: 8080,
      host: '0.0.0.0',
      roomTtlMinutes: 120,
      maxRooms: 500,
      trustProxy: 0,
      maxConnectionsPerIp: 20,
      maxRoomCreatesPerIp: 10,
    });
  });

  it('reads every variable', () => {
    expect(
      readConfig({
        PORT: '3000',
        HOST: ' 127.0.0.1 ',
        ROOM_TTL_MINUTES: '30',
        MAX_ROOMS: '50',
        TRUST_PROXY: '2',
        MAX_CONNECTIONS_PER_IP: '100',
        MAX_ROOM_CREATES_PER_IP: '25',
      }),
    ).toEqual({
      port: 3000,
      host: '127.0.0.1',
      roomTtlMinutes: 30,
      maxRooms: 50,
      trustProxy: 2,
      maxConnectionsPerIp: 100,
      maxRoomCreatesPerIp: 25,
    });
  });

  it('refuses a TRUST_PROXY that is not a number of proxies instead of reading it as 0', () => {
    for (const value of ['true', 'yes', '-1', '1.5', 'loopback']) {
      expect(() => readConfig({ TRUST_PROXY: value }), value).toThrow(ConfigError);
    }
    expect(() => readConfig({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY.*"true"/);
  });

  it('refuses per-IP limits that are not whole numbers of at least 1', () => {
    for (const value of ['off', 'none', '0', '-5', '2.5', 'Infinity']) {
      expect(() => readConfig({ MAX_CONNECTIONS_PER_IP: value }), value).toThrow(ConfigError);
      expect(() => readConfig({ MAX_ROOM_CREATES_PER_IP: value }), value).toThrow(ConfigError);
    }
  });

  it('names every bad variable at once', () => {
    let message = '';
    try {
      readConfig({ PORT: 'http', MAX_ROOMS: 'lots', TRUST_PROXY: 'true', ROOM_TTL_MINUTES: '0' });
    } catch (err) {
      message = (err as Error).message;
    }
    for (const name of ['PORT', 'MAX_ROOMS', 'TRUST_PROXY', 'ROOM_TTL_MINUTES']) {
      expect(message).toContain(name);
    }
  });
});

describe('entry points', () => {
  it('does not start with TRUST_PROXY=true, and says why', async () => {
    const run = await runEntry('index.ts', { TRUST_PROXY: 'true' });
    expect(run.listening).toBe(false);
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/TRUST_PROXY.*"true"/);
  }, 30_000);

  it('`pnpm dev` runs the server with generous per-IP limits (everyone is 127.0.0.1 there)', async () => {
    const pkg = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['dev']).toBe('tsx watch src/dev.ts');
    const run = await runEntry('dev.ts');
    expect(run.listening).toBe(true);
    expect(run.output).toContain('per IP: 1000 connections, 1000 room creates per 10 min');
    // Set by hand, the real limits apply, to try them out.
    const strict = await runEntry('dev.ts', { MAX_ROOM_CREATES_PER_IP: '10' });
    expect(strict.output).toContain('per IP: 1000 connections, 10 room creates per 10 min');
  }, 30_000);
});
