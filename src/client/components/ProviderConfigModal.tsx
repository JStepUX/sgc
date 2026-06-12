import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ProviderId } from '@/lib/api';
import type { DesktopConfigPatch, DesktopConfigState } from '@/lib/desktop';

// ============================================================
// PROVIDER CONFIG MODAL — configure EITHER provider from the chip dropdown
// (D5). Desktop mode: save → main writes sgc-config.json, restarts the
// embedded server, reloads the window — the restart IS the apply mechanism,
// the server still reads env once at boot. Web mode: the same fields render
// as documentation plus inline .env guidance — NO network write, the server
// stays frozen.
//
// Styled to mirror ConfirmPersonaModal: frosted overlay, rounded-[22px]
// dialog, Escape-cancel, Tab focus-trap. Stored keys are never displayed —
// configState is redacted (presence booleans only).
// ============================================================

interface ProviderConfigModalProps {
  open: boolean;
  provider: ProviderId;
  /** User-facing provider name (PROVIDER_LABEL — the single mapping site). */
  label: string;
  /** Redacted config from main; null on web / before the bridge answers. */
  configState: DesktopConfigState | null;
  mode: 'desktop' | 'web';
  /** Desktop save. The parent owns the bridge call (and the pre-save
   *  localStorage provider pre-set when opened from an unconfigured row). */
  onSave: (patch: DesktopConfigPatch) => Promise<void>;
  onCancel: () => void;
}

const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';
const INPUT =
  'w-full rounded-[14px] border border-hairline-strong bg-surface px-4 py-2.5 text-[13.5px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/55 disabled:cursor-not-allowed disabled:opacity-50';
const HELP = 'mt-1.5 text-[12px] leading-[1.5] text-fg-4';

// Curated Anthropic picker — ids + cost hints verified against the claude-api
// reference 2026-06-12. "(unset)" defers to the server default (the env /
// hardcoded fallback in src/server/index.ts — claude-opus-4-7 today).
const CUSTOM_MODEL = '__custom__';
const ANTHROPIC_MODELS: { id: string; label: string }[] = [
  { id: '', label: 'Server default — claude-opus-4-7' },
  { id: 'claude-opus-4-8', label: 'claude-opus-4-8 — most capable · $5/$25 per MTok' },
  { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6 — balanced · $3/$15 per MTok' },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5 — fastest + cheapest · $1/$5 per MTok' },
  { id: CUSTOM_MODEL, label: 'Custom…' },
];
const CURATED_IDS = new Set(ANTHROPIC_MODELS.map((m) => m.id));

export function ProviderConfigModal({
  open,
  provider,
  label,
  configState,
  mode,
  onSave,
  onCancel,
}: ProviderConfigModalProps) {
  // Anthropic fields
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [modelSelect, setModelSelect] = useState('');
  const [customModel, setCustomModel] = useState('');
  // LOCAL (openai) fields
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [clearOpenaiKey, setClearOpenaiKey] = useState(false);
  // Shared
  const [maxTokens, setMaxTokens] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);

  const isAnthropic = provider === 'anthropic';
  const isWeb = mode === 'web';
  const keyPresent = isAnthropic
    ? (configState?.anthropicKeyPresent ?? false)
    : (configState?.openaiKeyPresent ?? false);

  // Re-prime fields from the redacted config each time the modal opens —
  // a cancelled edit must not leak into the next open.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setApiKey('');
    setClearKey(false);
    setOpenaiKey('');
    setClearOpenaiKey(false);
    if (provider === 'anthropic') {
      const stored = configState?.anthropicModel ?? '';
      if (stored && !CURATED_IDS.has(stored)) {
        setModelSelect(CUSTOM_MODEL);
        setCustomModel(stored);
      } else {
        setModelSelect(stored);
        setCustomModel('');
      }
      setMaxTokens(configState?.anthropicMaxTokens?.toString() ?? '');
    } else {
      setBaseUrl(configState?.openaiBaseUrl ?? '');
      setModelName(configState?.llmModel ?? '');
      setMaxTokens(configState?.llmMaxTokens?.toString() ?? '');
    }
    // Focus the first interactive field (web mode disables them all — the
    // focus trap then starts from the close button instead).
    const id = setTimeout(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled])')
        ?.focus();
    }, 30);
    return () => clearTimeout(id);
  }, [open, provider, configState]);

  // Escape → cancel (unless mid-restart). Tab/Shift+Tab cycle within dialog.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const handleSave = async () => {
    // Validation: max tokens a positive integer (blank = server default);
    // base URL must parse as http(s) when present.
    const tokensRaw = maxTokens.trim();
    let tokensValue: number | '' = '';
    if (tokensRaw !== '') {
      const n = Number(tokensRaw);
      if (!Number.isInteger(n) || n <= 0) {
        setError('Max tokens must be a positive integer (or blank for the server default).');
        return;
      }
      tokensValue = n;
    }

    let patch: DesktopConfigPatch;
    if (isAnthropic) {
      const model = modelSelect === CUSTOM_MODEL ? customModel.trim() : modelSelect;
      patch = { anthropicModel: model, anthropicMaxTokens: tokensValue };
      if (clearKey) patch.anthropicApiKey = '';
      else if (apiKey.trim()) patch.anthropicApiKey = apiKey.trim();
    } else {
      const url = baseUrl.trim();
      if (url !== '') {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
        } catch {
          setError('Base URL must be a valid http(s) URL, e.g. http://localhost:5001/v1');
          return;
        }
      }
      patch = { openaiBaseUrl: url, llmModel: modelName.trim(), llmMaxTokens: tokensValue };
      if (clearOpenaiKey) patch.openaiApiKey = '';
      else if (openaiKey.trim()) patch.openaiApiKey = openaiKey.trim();
    }

    setError(null);
    setBusy(true);
    try {
      // Packaged: main writes config, restarts the server, reloads the window
      // — this promise usually dissolves into the reload.
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const keyField = (
    value: string,
    setValue: (v: string) => void,
    cleared: boolean,
    setCleared: (v: boolean) => void,
    inputId: string,
    optional: boolean,
  ) => (
    <>
      <label htmlFor={inputId} className={`${RAIL_LABEL} mb-2 block`}>
        API key{optional ? ' (optional)' : ''}
      </label>
      <input
        id={inputId}
        type="password"
        value={value}
        disabled={isWeb || busy}
        onChange={(e) => {
          setValue(e.target.value);
          if (cleared) setCleared(false);
        }}
        placeholder={
          cleared
            ? 'stored key will be removed on save'
            : keyPresent
              ? '•••••• key on file — blank keeps it'
              : isAnthropic
                ? 'sk-ant-…'
                : 'blank for KoboldCPP (it ignores keys)'
        }
        spellCheck={false}
        autoComplete="off"
        className={INPUT}
      />
      {keyPresent && !isWeb && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setCleared(!cleared)}
          className="mt-1.5 font-mono text-[11px] tracking-[0.06em] text-fg-3 underline-offset-2 hover:text-danger hover:underline disabled:opacity-50"
        >
          {cleared ? 'Keep the stored key' : 'Clear the stored key'}
        </button>
      )}
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={busy ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-config-title"
        className="relative flex max-h-[86vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={RAIL_LABEL}>Reasoning model</span>
            <h2
              id="provider-config-title"
              className="font-serif text-[22px] italic leading-tight text-fg-1"
            >
              Configure {label}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Cancel"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone disabled:opacity-50"
          >
            <X className="size-[15px]" />
          </button>
        </div>

        <div className="sal-scroll min-h-0 flex-1 overflow-y-auto px-7 pt-5 pb-4">
          {isWeb && (
            <p className="mb-5 rounded-[14px] border border-hairline bg-surface-thin px-4 py-3 text-[12.5px] leading-[1.6] text-fg-3">
              This is a web deployment — provider config lives in the{' '}
              <span className="font-mono text-[11.5px]">.env</span> of the server, never the
              browser. Set{' '}
              <span className="font-mono text-[11.5px]">
                {isAnthropic
                  ? 'ANTHROPIC_API_KEY · ANTHROPIC_MODEL · ANTHROPIC_MAX_TOKENS'
                  : 'OPENAI_BASE_URL · LLM_MODEL · LLM_MAX_TOKENS · OPENAI_API_KEY'}
              </span>{' '}
              there and restart the server.
            </p>
          )}

          {isAnthropic ? (
            <>
              {keyField(apiKey, setApiKey, clearKey, setClearKey, 'anthropic-key', false)}

              <label htmlFor="anthropic-model" className={`${RAIL_LABEL} mt-5 mb-2 block`}>
                Model
              </label>
              <select
                id="anthropic-model"
                value={modelSelect}
                disabled={isWeb || busy}
                onChange={(e) => setModelSelect(e.target.value)}
                className={INPUT}
              >
                {ANTHROPIC_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              {modelSelect === CUSTOM_MODEL && (
                <input
                  aria-label="Custom model id"
                  value={customModel}
                  disabled={isWeb || busy}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="any model id, e.g. claude-opus-4-7"
                  spellCheck={false}
                  className={`${INPUT} mt-2 font-mono text-[12.5px]`}
                />
              )}

              <label htmlFor="anthropic-max-tokens" className={`${RAIL_LABEL} mt-5 mb-2 block`}>
                Max tokens
              </label>
              <input
                id="anthropic-max-tokens"
                value={maxTokens}
                disabled={isWeb || busy}
                onChange={(e) => setMaxTokens(e.target.value)}
                inputMode="numeric"
                placeholder="blank = server default (16384)"
                className={INPUT}
              />
            </>
          ) : (
            <>
              <label htmlFor="local-base-url" className={`${RAIL_LABEL} mb-2 block`}>
                Base URL
              </label>
              <input
                id="local-base-url"
                value={baseUrl}
                disabled={isWeb || busy}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:5001/v1"
                spellCheck={false}
                className={`${INPUT} font-mono text-[12.5px]`}
              />
              <p className={HELP}>
                KoboldCPP default shown. Ollama:{' '}
                <span className="font-mono">http://localhost:11434/v1</span>
              </p>

              <label htmlFor="local-model" className={`${RAIL_LABEL} mt-5 mb-2 block`}>
                Model name
              </label>
              <input
                id="local-model"
                value={modelName}
                disabled={isWeb || busy}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="koboldcpp"
                spellCheck={false}
                className={`${INPUT} font-mono text-[12.5px]`}
              />
              <p className={HELP}>
                Label-only for KoboldCPP; for Ollama it MUST match a pulled model.
              </p>

              <label htmlFor="local-max-tokens" className={`${RAIL_LABEL} mt-5 mb-2 block`}>
                Max tokens
              </label>
              <input
                id="local-max-tokens"
                value={maxTokens}
                disabled={isWeb || busy}
                onChange={(e) => setMaxTokens(e.target.value)}
                inputMode="numeric"
                placeholder="blank = server default (512)"
                className={INPUT}
              />
              <p className={HELP}>
                512 can truncate the reply + turn-summary block — 1024+ recommended.
              </p>

              <div className="mt-5">
                {keyField(
                  openaiKey,
                  setOpenaiKey,
                  clearOpenaiKey,
                  setClearOpenaiKey,
                  'local-key',
                  true,
                )}
              </div>
            </>
          )}

          {error && (
            <p className="mt-4 rounded-[14px] border border-danger/40 bg-danger/10 px-4 py-2.5 text-[12.5px] leading-[1.5] text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-hairline px-7 py-4">
          {isWeb ? (
            <Button size="sm" onClick={onCancel} className="font-mono text-[11px]">
              Close
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={busy}
                className="font-mono text-[11px] text-fg-3"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={busy}
                className="font-mono text-[11px]"
              >
                {busy ? 'Restarting Sal…' : 'Save & restart'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
