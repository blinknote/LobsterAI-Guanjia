export function isGuanjiaScopedSessionKey(sessionKey: string | undefined | null): boolean {
  if (!sessionKey || typeof sessionKey !== "string") return false;
  const raw = sessionKey.trim();
  return /^agent:guanjia-assistant:lobsterai:[^:]+$/.test(raw);
}

export function extractSessionIdFromManagedKey(sessionKey: string | undefined | null): string | null {
  if (!sessionKey || typeof sessionKey !== "string") return null;
  const raw = sessionKey.trim();
  if (!isGuanjiaScopedSessionKey(raw)) return null;
  const parts = raw.split(":");
  if (parts.length < 4) return null;
  return parts.slice(3).join(":").trim() || null;
}
