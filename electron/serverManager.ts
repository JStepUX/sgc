// Embedded-server lifecycle for the packaged app.
//
// The Express server (dist/server/index.js, ESM, byte-identical to the dev
// server) is forked with env derived from sgc-config.json. A config change is
// applied by restart() — never by mutating the running server (D3/D5). The
// chosen port is persisted to sgc-config.json (serverPort) and reused on every
// launch so the renderer's origin — and its per-origin localStorage — stays
// stable across launches.

import { app, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { configToEnv, readConfig, writeConfig } from './config';

export interface ServerHandle {
  port: number;
  pid: number;
}

/** Minimal process adapter so the launch strategy is swappable (see launch). */
interface LaunchedServer {
  pid: number;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(force: boolean): void;
}

const HEALTH_POLL_MS = 150;
const HEALTH_TIMEOUT_MS = 15_000;
const START_ATTEMPTS = 3;
const LOG_TAIL_LINES = 40;

let child: LaunchedServer | null = null;
let childExited = false;
let currentPort: number | null = null;
let logStream: WriteStream | null = null;
const logTail: string[] = [];

// --- launch strategies -------------------------------------------------
// PRIMARY: utilityProcess.fork — Electron's own Node + ABI, lifecycle-managed.
// FALLBACK (swap the `launch` assignment): launchViaNodeSpawn — plain Node via
// ELECTRON_RUN_AS_NODE, same ABI, Node's own ESM loader. If the fallback ever
// SHIPS, also add "dist/server/**" to asarUnpack — plain-Node ESM loading from
// inside asar is unreliable.

function launchViaUtilityProcess(entry: string, env: Record<string, string>): LaunchedServer {
  const proc = utilityProcess.fork(entry, [], {
    env,
    cwd: app.getPath('userData'),
    stdio: 'pipe',
    serviceName: 'sgc-server',
  });
  return {
    get pid() {
      return proc.pid ?? -1;
    },
    onStdout: (cb) => proc.stdout?.on('data', cb),
    onStderr: (cb) => proc.stderr?.on('data', cb),
    onExit: (cb) => proc.once('exit', cb),
    kill: () => proc.kill(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept as the documented swappable fallback (spec: launch)
function launchViaNodeSpawn(entry: string, env: Record<string, string>): LaunchedServer {
  const proc = spawn(process.execPath, [entry], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: app.getPath('userData'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    get pid() {
      return proc.pid ?? -1;
    },
    onStdout: (cb) => proc.stdout.on('data', cb),
    onStderr: (cb) => proc.stderr.on('data', cb),
    onExit: (cb) => proc.once('exit', cb),
    kill: (force) => proc.kill(force ? 'SIGKILL' : 'SIGTERM'),
  };
}

const launch: (entry: string, env: Record<string, string>) => LaunchedServer = launchViaUtilityProcess;

// --- port resolution ----------------------------------------------------

function probePortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error('could not read probe port')));
      }
    });
  });
}

/** Prefer the persisted serverPort when it is still free (origin stability);
 *  otherwise pick a fresh ephemeral port. Small TOCTOU window — the health
 *  poll plus start() retries cover collisions. */
async function resolvePort(forceFresh: boolean): Promise<number> {
  if (!forceFresh) {
    const persisted = readConfig().serverPort;
    if (
      typeof persisted === 'number' &&
      Number.isInteger(persisted) &&
      persisted > 0 &&
      persisted < 65536 &&
      (await probePortFree(persisted))
    ) {
      return persisted;
    }
  }
  return pickFreePort();
}

// --- logging --------------------------------------------------------------

function logFilePath(): string {
  return path.join(app.getPath('userData'), 'logs', 'server.log');
}

function openLog(): void {
  if (logStream) return;
  const file = logFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  logStream = createWriteStream(file, { flags: 'a' });
}

function teeLog(chunk: Buffer): void {
  logStream?.write(chunk);
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    logTail.push(line);
    if (logTail.length > LOG_TAIL_LINES) logTail.shift();
  }
}

export function getLogTail(): string {
  return logTail.join('\n');
}

export function getLogFilePath(): string {
  return logFilePath();
}

// --- env ------------------------------------------------------------------

// Env names the config layer owns. Scrubbed from the inherited env before the
// config-derived values are applied, so sgc-config.json is the single source
// of truth — a stray ANTHROPIC_API_KEY in the launching shell can't make the
// packaged app's provider availability differ from what the config says.
const MANAGED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MAX_TOKENS',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'LLM_MODEL',
  'LLM_MAX_TOKENS',
  'LLM_PROVIDER',
] as const;

function buildServerEnv(port: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of MANAGED_ENV_KEYS) delete env[key];
  Object.assign(env, configToEnv(readConfig()), {
    PORT: String(port),
    // MANDATORY — without it db.ts writes under process.cwd() (Program Files,
    // non-writable in a packaged install) and crashes at import-time mkdirSync.
    SGC_DB_PATH: path.join(app.getPath('userData'), 'data', 'sgc.db'),
    // Same-origin anyway (renderer loads the server's own origin); set defensively.
    CORS_ORIGIN: `http://127.0.0.1:${port}`,
  });
  return env;
}

// --- health ----------------------------------------------------------------

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childExited) throw new Error('server process exited during startup');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      /* not up yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

// --- lifecycle ---------------------------------------------------------------

function serverEntryAbs(): string {
  // dist/electron/ → dist/server/index.js (absolute; __dirname is real under
  // the CJS bundle).
  return path.join(__dirname, '../server/index.js');
}

async function startAttempt(port: number): Promise<ServerHandle> {
  openLog();
  const env = buildServerEnv(port);
  childExited = false;
  const proc = launch(serverEntryAbs(), env);
  child = proc;
  proc.onStdout(teeLog);
  proc.onStderr(teeLog);
  proc.onExit(() => {
    // Identity-gated: a LATE exit from a PREVIOUS child (stop() force-kill
    // path resolves on a timer, possibly before the old exit event lands)
    // must not flip childExited while a new child is mid-health-poll —
    // waitForHealth and isRunning() read it for the CURRENT child only.
    if (child === proc) {
      childExited = true;
      child = null;
    }
  });
  await waitForHealth(port);
  currentPort = port;
  return { port, pid: proc.pid };
}

/** resolvePort → fork → waitForHealth. Retries (fresh port) on failure. */
export async function start(): Promise<ServerHandle> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const port = await resolvePort(attempt > 0);
    try {
      const handle = await startAttempt(port);
      if (readConfig().serverPort !== port) writeConfig({ serverPort: port });
      return handle;
    } catch (err) {
      lastError = err;
      await stop();
    }
  }
  throw new Error(
    `SGC server failed to start after ${START_ATTEMPTS} attempts: ${String(lastError)}\n\n` +
      `log: ${logFilePath()}\n--- last output ---\n${getLogTail()}`,
  );
}

/** stop → start. resolvePort prefers the persisted port, so within a session
 *  the origin survives the restart (the window reload must not change it). */
export async function restart(): Promise<ServerHandle> {
  await stop();
  return start();
}

/** Graceful kill → forced kill fallback after a grace period. */
export function stop(): Promise<void> {
  const proc = child;
  if (!proc || childExited) {
    child = null;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child = null;
      resolve();
    };
    proc.onExit(finish);
    proc.kill(false);
    setTimeout(() => {
      if (!settled) {
        proc.kill(true);
        setTimeout(finish, 1_000);
      }
    }, 5_000).unref?.();
  });
}

export function getPort(): number | null {
  return currentPort;
}

export function isRunning(): boolean {
  return child !== null && !childExited;
}
