import type { ProviderId } from './api';

// ============================================================
// PROVIDER SWITCHER TYPES
// Mirrors GET /api/health. The client only ever holds a provider TOKEN; the
// server owns keys/URLs. A local model is just a different (still ephemeral)
// Sal — switching mid-chat is harmless (no state carried).
// ============================================================

export interface ProviderInfo {
  available: boolean;
  model: string;
  label?: string;
}

export interface HealthResponse {
  ok: boolean;
  default: ProviderId | null;
  providers: Record<ProviderId, ProviderInfo>;
}

// User-facing label: 'openai' is the dialect it speaks, but it runs LOCALly.
// This is the single mapping site (spec: api_choice.naming.mapping_location).
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC',
  openai: 'LOCAL',
};

export const PROVIDER_LS_KEY = 'sgc.provider';
export const PROVIDER_ORDER: ProviderId[] = ['anthropic', 'openai'];
