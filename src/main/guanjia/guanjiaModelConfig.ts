import type { GuanjiaClientModelConfig } from './types';

let cachedGuanjiaModelConfig: GuanjiaClientModelConfig | null = null;
let isGuanjiaAuthenticated = false;

export function setGuanjiaAuthenticated(authenticated: boolean): void {
  isGuanjiaAuthenticated = authenticated;
  if (!authenticated) {
    cachedGuanjiaModelConfig = null;
  }
}

export function isGuanjiaSessionAuthenticated(): boolean {
  return isGuanjiaAuthenticated;
}

export function setCachedGuanjiaModelConfig(config: GuanjiaClientModelConfig | null): void {
  if (!config) {
    cachedGuanjiaModelConfig = null;
  } else {
    cachedGuanjiaModelConfig = { ...config };
  }
}

export function getCachedGuanjiaModelConfig(): GuanjiaClientModelConfig | null {
  if (!isGuanjiaAuthenticated && !cachedGuanjiaModelConfig) {
    return null;
  }
  return cachedGuanjiaModelConfig ? { ...cachedGuanjiaModelConfig } : null;
}

export function isGuanjiaSystemModelActive(): boolean {
  if (!isGuanjiaAuthenticated) {
    return false;
  }
  if (!cachedGuanjiaModelConfig) {
    return true;
  }
  return cachedGuanjiaModelConfig.client_ai_provider === 'system_builtin';
}

export function getEffectiveGuanjiaSystemBuiltinModelRef(): string | null {
  if (!isGuanjiaSystemModelActive()) {
    return null;
  }
  const modelName = cachedGuanjiaModelConfig?.model_name || 'gemini-3.8-flash-high';
  return `system_builtin/${modelName}`;
}
