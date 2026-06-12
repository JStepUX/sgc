// SGC desktop config — plaintext JSON at <userData>/sgc-config.json (D2).
//
// This module is deliberately electron-free: the path is injected via
// initConfig() so the pure logic (merge/delete semantics, env mapping) is
// unit-testable under vitest without an Electron runtime. main.ts binds the
// real userData path at startup.
//
// The server NEVER reads this file. main derives the fork's env from it
// (configToEnv) and a config change is applied by restarting the fork (D3/D5)
// — src/server/* stays byte-identical, reading env once at boot as today.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SgcConfig {
  anthropicApiKey?: string;
  anthropicModel?: string;
  anthropicMaxTokens?: number;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  llmModel?: string;
  llmMaxTokens?: number;
  llmProvider?: 'anthropic' | 'openai';
  /** Persisted by serverManager so the origin (and the renderer's
   *  per-origin localStorage) stays stable across launches. */
  serverPort?: number;
}

/** The renderer-settable subset (whitelisted in main, not just typed —
 *  llmProvider/serverPort are never renderer-settable). Empty string or null
 *  on any field = DELETE it from the config (clear semantics for the modal). */
export type ConfigPatchKey =
  | 'anthropicApiKey'
  | 'anthropicModel'
  | 'anthropicMaxTokens'
  | 'openaiBaseUrl'
  | 'openaiApiKey'
  | 'llmModel'
  | 'llmMaxTokens';

export type ConfigPatch = { [K in ConfigPatchKey]?: SgcConfig[K] | '' | null };

/** Redacted shape handed to the renderer — never raw keys. */
export interface ConfigState {
  anthropicKeyPresent: boolean;
  openaiKeyPresent: boolean;
  anthropicModel?: string;
  anthropicMaxTokens?: number;
  openaiBaseUrl?: string;
  llmModel?: string;
  llmMaxTokens?: number;
}

let configFile: string | null = null;

export function initConfig(filePath: string): void {
  configFile = filePath;
}

function requireConfigFile(): string {
  if (!configFile) throw new Error('config not initialised — call initConfig(filePath) first');
  return configFile;
}

/** {} if missing/corrupt; never throws. */
export function readConfig(): SgcConfig {
  const file = requireConfigFile();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SgcConfig;
    }
    return {};
  } catch {
    return {};
  }
}

/** Merge the patch into the stored config and write atomically (tmp file +
 *  renameSync). Empty-string/null values DELETE the field. Returns the new
 *  config. */
export function writeConfig(patch: Partial<Record<keyof SgcConfig, unknown>>): SgcConfig {
  const file = requireConfigFile();
  const next: Record<string, unknown> = { ...readConfig() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === '' || value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return next as SgcConfig;
}

/** Map present fields → the server's env names, and ONLY those. serverPort is
 *  excluded — it is consumed by serverManager, which sets PORT itself. */
export function configToEnv(cfg: SgcConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.anthropicApiKey) env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  if (cfg.anthropicModel) env.ANTHROPIC_MODEL = cfg.anthropicModel;
  if (cfg.anthropicMaxTokens !== undefined) env.ANTHROPIC_MAX_TOKENS = String(cfg.anthropicMaxTokens);
  if (cfg.openaiBaseUrl) env.OPENAI_BASE_URL = cfg.openaiBaseUrl;
  if (cfg.openaiApiKey) env.OPENAI_API_KEY = cfg.openaiApiKey;
  if (cfg.llmModel) env.LLM_MODEL = cfg.llmModel;
  if (cfg.llmMaxTokens !== undefined) env.LLM_MAX_TOKENS = String(cfg.llmMaxTokens);
  if (cfg.llmProvider) env.LLM_PROVIDER = cfg.llmProvider;
  return env;
}

/** Redact the stored config for the renderer (ConfigState — presence booleans
 *  instead of key material). */
export function redactConfig(cfg: SgcConfig): ConfigState {
  return {
    anthropicKeyPresent: Boolean(cfg.anthropicApiKey),
    openaiKeyPresent: Boolean(cfg.openaiApiKey),
    anthropicModel: cfg.anthropicModel,
    anthropicMaxTokens: cfg.anthropicMaxTokens,
    openaiBaseUrl: cfg.openaiBaseUrl,
    llmModel: cfg.llmModel,
    llmMaxTokens: cfg.llmMaxTokens,
  };
}

type StringPatchKey = 'anthropicApiKey' | 'anthropicModel' | 'openaiBaseUrl' | 'openaiApiKey' | 'llmModel';
type NumberPatchKey = 'anthropicMaxTokens' | 'llmMaxTokens';

/** Drop non-ConfigPatch keys (llmProvider, serverPort, anything unknown) so
 *  the renderer can never steer process supervision. Runs in MAIN. */
export function whitelistPatch(patch: unknown): ConfigPatch {
  const clean: ConfigPatch = {};
  if (!patch || typeof patch !== 'object') return clean;
  const record = patch as Record<string, unknown>;
  const takeString = (key: StringPatchKey) => {
    if (!(key in record)) return;
    const value = record[key];
    if (value === '' || value === null) clean[key] = '';
    else if (typeof value === 'string') clean[key] = value;
  };
  const takeNumber = (key: NumberPatchKey) => {
    if (!(key in record)) return;
    const value = record[key];
    if (value === '' || value === null) {
      clean[key] = '';
    } else {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) clean[key] = n;
    }
  };
  takeString('anthropicApiKey');
  takeString('anthropicModel');
  takeString('openaiBaseUrl');
  takeString('openaiApiKey');
  takeString('llmModel');
  takeNumber('anthropicMaxTokens');
  takeNumber('llmMaxTokens');
  return clean;
}
