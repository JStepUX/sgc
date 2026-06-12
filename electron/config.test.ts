// Behavioral tests for the desktop config store (electron/config.ts).
// The module is electron-free by design — the config path is injected via
// initConfig(), so these run under plain vitest/Node.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configToEnv,
  initConfig,
  readConfig,
  redactConfig,
  whitelistPatch,
  writeConfig,
  type SgcConfig,
} from './config';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sgc-config-test-'));
  file = join(dir, 'sgc-config.json');
  initConfig(file);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('returns {} when the file is missing', () => {
    expect(readConfig()).toEqual({});
  });

  it('returns {} when the file is corrupt JSON', () => {
    writeFileSync(file, '{not json', 'utf8');
    expect(readConfig()).toEqual({});
  });

  it('returns {} when the file holds a non-object', () => {
    writeFileSync(file, '[1,2,3]', 'utf8');
    expect(readConfig()).toEqual({});
  });

  it('round-trips what writeConfig stored', () => {
    writeConfig({ anthropicApiKey: 'test-anthropic-key', serverPort: 4242 });
    expect(readConfig()).toEqual({ anthropicApiKey: 'test-anthropic-key', serverPort: 4242 });
  });
});

describe('writeConfig', () => {
  it('merges patches into the existing config', () => {
    writeConfig({ anthropicApiKey: 'test-anthropic-key' });
    writeConfig({ llmModel: 'qwen3' });
    expect(readConfig()).toEqual({ anthropicApiKey: 'test-anthropic-key', llmModel: 'qwen3' });
  });

  it('deletes a field on empty-string patch value', () => {
    writeConfig({ anthropicApiKey: 'test-anthropic-key', anthropicMaxTokens: 4096 });
    writeConfig({ anthropicApiKey: '' });
    expect(readConfig()).toEqual({ anthropicMaxTokens: 4096 });
  });

  it('deletes a field on null patch value', () => {
    writeConfig({ openaiBaseUrl: 'http://localhost:5001/v1' });
    writeConfig({ openaiBaseUrl: null });
    expect(readConfig()).toEqual({});
  });

  it('ignores undefined patch values (no delete, no set)', () => {
    writeConfig({ llmMaxTokens: 1024 });
    writeConfig({ llmMaxTokens: undefined });
    expect(readConfig()).toEqual({ llmMaxTokens: 1024 });
  });

  it('leaves no tmp file behind (atomic rename)', () => {
    writeConfig({ anthropicModel: 'claude-haiku-4-5' });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ anthropicModel: 'claude-haiku-4-5' });
  });
});

describe('configToEnv', () => {
  it('maps every present field to its server env name', () => {
    const cfg: SgcConfig = {
      anthropicApiKey: 'test-anthropic-key',
      anthropicModel: 'claude-haiku-4-5',
      anthropicMaxTokens: 8192,
      openaiBaseUrl: 'http://localhost:5001/v1',
      openaiApiKey: 'local-key',
      llmModel: 'qwen3',
      llmMaxTokens: 1024,
      llmProvider: 'openai',
    };
    expect(configToEnv(cfg)).toEqual({
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      ANTHROPIC_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_MAX_TOKENS: '8192',
      OPENAI_BASE_URL: 'http://localhost:5001/v1',
      OPENAI_API_KEY: 'local-key',
      LLM_MODEL: 'qwen3',
      LLM_MAX_TOKENS: '1024',
      LLM_PROVIDER: 'openai',
    });
  });

  it('omits absent fields entirely (server defaults stay in charge)', () => {
    expect(configToEnv({})).toEqual({});
    expect(configToEnv({ anthropicApiKey: 'test-anthropic-key' })).toEqual({
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    });
  });

  it('EXCLUDES serverPort — consumed by serverManager, never forwarded', () => {
    const env = configToEnv({ serverPort: 4242, llmMaxTokens: 1024 });
    expect(env).toEqual({ LLM_MAX_TOKENS: '1024' });
    expect(Object.keys(env)).not.toContain('PORT');
  });

  it('maps llmMaxTokens → LLM_MAX_TOKENS (the D5 gap this spec closes)', () => {
    expect(configToEnv({ llmMaxTokens: 2048 })).toEqual({ LLM_MAX_TOKENS: '2048' });
  });
});

describe('whitelistPatch', () => {
  it('drops llmProvider, serverPort, and unknown keys', () => {
    expect(
      whitelistPatch({
        anthropicApiKey: 'test-anthropic-key',
        llmProvider: 'openai',
        serverPort: 1337,
        __proto__pollution: 'x',
        nodeIntegration: true,
      }),
    ).toEqual({ anthropicApiKey: 'test-anthropic-key' });
  });

  it('passes through delete sentinels as empty string', () => {
    expect(whitelistPatch({ anthropicApiKey: '', llmMaxTokens: null })).toEqual({
      anthropicApiKey: '',
      llmMaxTokens: '',
    });
  });

  it('coerces numeric fields and rejects non-positive or fractional values', () => {
    expect(whitelistPatch({ anthropicMaxTokens: '8192' })).toEqual({ anthropicMaxTokens: 8192 });
    expect(whitelistPatch({ anthropicMaxTokens: -5 })).toEqual({});
    expect(whitelistPatch({ llmMaxTokens: 1.5 })).toEqual({});
  });

  it('rejects non-string values for string fields', () => {
    expect(whitelistPatch({ anthropicModel: 42 })).toEqual({});
    expect(whitelistPatch(null)).toEqual({});
    expect(whitelistPatch('nope')).toEqual({});
  });
});

describe('redactConfig', () => {
  it('replaces key material with presence booleans', () => {
    const state = redactConfig({
      anthropicApiKey: 'test-anthropic-key',
      anthropicModel: 'claude-haiku-4-5',
      llmMaxTokens: 1024,
    });
    expect(state.anthropicKeyPresent).toBe(true);
    expect(state.openaiKeyPresent).toBe(false);
    expect(state.anthropicModel).toBe('claude-haiku-4-5');
    expect(state.llmMaxTokens).toBe(1024);
    expect(JSON.stringify(state)).not.toContain('test-anthropic-key');
  });
});
