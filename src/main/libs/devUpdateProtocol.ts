import crypto from 'crypto';

import {
  APP_UPDATE_DEV_REVOKED_ERROR,
  APP_UPDATE_DEV_SCOPE_MISMATCH_ERROR,
  APP_UPDATE_DEV_UNTRUSTED_ERROR,
} from '../../shared/appUpdate/constants';
import {
  DEV_UPDATE_SCOPE,
  type DevUpdateCandidateReceipt,
  type DevUpdateCandidateStatus,
  type DevUpdateChannelPayload,
  type DevUpdateReleasePayload,
  type DevUpdateSignedEnvelope,
} from '../../shared/appUpdate/devUpdateTypes';

export { DEV_UPDATE_SCOPE };

export const DEV_UPDATE_FEED_URL = 'https://updates.a-j.app';
export const DEV_UPDATE_CHANNEL_CHECK_PATH = '/api/v1/channel/check';
export const MAX_METADATA_BYTES = 131072; // 128 KiB
export const MAX_RELEASE_PAYLOAD_BYTES = 32768; // 32 KiB
export const MAX_INSTALLER_BYTES = 1073741824; // 1 GiB
export const CLOCK_TOLERANCE_SECONDS = 120;
export const CHANNEL_EXPIRY_SECONDS = 600; // 10 minutes
export const REQUEST_TIMEOUT_MS = 10000; // <= 10s verification request

export const RELEASE_SIGN_DOMAIN = 'LobsterAI-Dev-Windows-Updates/v1/release\n';
export const CHANNEL_SIGN_DOMAIN = 'LobsterAI-Dev-Windows-Updates/v1/channel\n';

/**
 * Server Real Public Key generated for Windows Dev updates.
 * Private key remains strictly server-side.
 */
export const TRUSTED_DEV_UPDATE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'windows-dev-5e307957d877ff9a': 'MCowBQYDK2VwAyEAcWWUpKzYannxZbWkXN1wX84HKez6E4aVOhkqCb7+zM0=',
});

export class DevUpdateVerificationError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Dev update verification error: ${reason}`);
    this.name = 'DevUpdateVerificationError';
    this.reason = reason;
  }
}

export class DevUpdateRevokedError extends Error {
  readonly releaseId: string;
  readonly sha256: string;
  readonly status: 'revoked' | 'unrecognized';

  constructor(releaseId: string, sha256: string, status: 'revoked' | 'unrecognized') {
    super(`${APP_UPDATE_DEV_REVOKED_ERROR}: releaseId=${releaseId}, sha256=${sha256}, status=${status}`);
    this.name = 'DevUpdateRevokedError';
    this.releaseId = releaseId;
    this.sha256 = sha256;
    this.status = status;
  }
}

export class DevUpdateTransportError extends Error {
  readonly isOfflineEligible: boolean;
  readonly statusCode?: number;
  readonly code?: string;

  constructor(message: string, options: { isOfflineEligible: boolean; statusCode?: number; code?: string }) {
    super(message);
    this.name = 'DevUpdateTransportError';
    this.isOfflineEligible = options.isOfflineEligible;
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}

/**
 * Strict JSON parser that rejects any object containing duplicate keys.
 */
export function parseStrictJsonWithoutDuplicates(jsonString: string): unknown {
  if (typeof jsonString !== 'string') {
    throw new DevUpdateVerificationError('invalid-json-type', 'JSON input must be a string');
  }

  // Verify standard JSON syntax first
  try {
    JSON.parse(jsonString);
  } catch (err) {
    throw new DevUpdateVerificationError('malformed-json', err instanceof Error ? err.message : String(err));
  }

  // Scan JSON AST to strictly reject any duplicate object keys
  let pos = 0;
  const len = jsonString.length;

  function skipWhitespace(): void {
    while (pos < len) {
      const ch = jsonString.charCodeAt(pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        pos += 1;
      } else {
        break;
      }
    }
  }

  function readString(): string {
    pos += 1; // skip opening quote
    let str = '';
    while (pos < len) {
      const ch = jsonString.charCodeAt(pos);
      if (ch === 34) { // quote
        pos += 1;
        return JSON.parse('"' + str + '"') as string;
      }
      if (ch === 92) { // backslash
        const next = jsonString[pos + 1];
        if (next === 'u') {
          str += jsonString.slice(pos, pos + 6);
          pos += 6;
        } else {
          str += jsonString.slice(pos, pos + 2);
          pos += 2;
        }
      } else {
        str += jsonString[pos];
        pos += 1;
      }
    }
    throw new DevUpdateVerificationError('unterminated-string', 'Unterminated string in JSON');
  }

  function scanValue(): void {
    skipWhitespace();
    if (pos >= len) return;
    const ch = jsonString.charCodeAt(pos);
    if (ch === 123) { // '{'
      scanObject();
    } else if (ch === 91) { // '['
      scanArray();
    } else if (ch === 34) { // '\"'
      readString();
    } else {
      while (pos < len) {
        const c = jsonString.charCodeAt(pos);
        if (c === 44 || c === 125 || c === 93 || c === 32 || c === 9 || c === 10 || c === 13) {
          break;
        }
        pos += 1;
      }
    }
  }

  function scanObject(): void {
    pos += 1; // skip '{'
    const seenKeys = new Set<string>();
    skipWhitespace();
    if (pos < len && jsonString.charCodeAt(pos) === 125) {
      pos += 1;
      return;
    }
    while (pos < len) {
      skipWhitespace();
      const key = readString();
      if (seenKeys.has(key)) {
        throw new DevUpdateVerificationError('duplicate-json-key', `Duplicate key in JSON object: "${key}"`);
      }
      seenKeys.add(key);
      skipWhitespace();
      pos += 1; // skip ':'
      scanValue();
      skipWhitespace();
      const next = jsonString.charCodeAt(pos);
      if (next === 125) {
        pos += 1;
        return;
      }
      pos += 1; // skip ','
    }
  }

  function scanArray(): void {
    pos += 1; // skip '['
    skipWhitespace();
    if (pos < len && jsonString.charCodeAt(pos) === 93) {
      pos += 1;
      return;
    }
    while (pos < len) {
      scanValue();
      skipWhitespace();
      const next = jsonString.charCodeAt(pos);
      if (next === 93) {
        pos += 1;
        return;
      }
      pos += 1; // skip ','
    }
  }

  scanValue();
  return JSON.parse(jsonString) as unknown;
}

/**
 * Verify that a string is strictly canonical Base64 without whitespace or non-canonical bits.
 */
export function isCanonicalBase64(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

/**
 * Check that an object matches exact expected keys and has no arbitrary/extra keys.
 */
export function assertExactKeys(obj: Record<string, unknown>, allowedKeys: readonly string[], context: string): void {
  const actualKeys = Object.keys(obj);
  const allowedSet = new Set(allowedKeys);
  for (const k of actualKeys) {
    if (!allowedSet.has(k)) {
      throw new DevUpdateVerificationError(
        'unexpected-remote-key',
        `Unexpected arbitrary key "${k}" found in ${context}`,
      );
    }
  }
  for (const k of allowedKeys) {
    if (!(k in obj)) {
      throw new DevUpdateVerificationError(
        'missing-required-key',
        `Missing required key "${k}" in ${context}`,
      );
    }
  }
}

export function validateDevScope(scope: unknown): boolean {
  if (!scope || typeof scope !== 'object') return false;
  const s = scope as Record<string, unknown>;
  return (
    s.product === DEV_UPDATE_SCOPE.product
    && s.appId === DEV_UPDATE_SCOPE.appId
    && s.channel === DEV_UPDATE_SCOPE.channel
    && s.platform === DEV_UPDATE_SCOPE.platform
    && s.arch === DEV_UPDATE_SCOPE.arch
    && s.packageType === DEV_UPDATE_SCOPE.packageType
  );
}

export function validateDevVersion(version: string): boolean {
  if (typeof version !== 'string') return false;
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return false;
  const p1 = Number(match[1]);
  const p2 = Number(match[2]);
  const p3 = Number(match[3]);
  return Number.isSafeInteger(p1) && Number.isSafeInteger(p2) && Number.isSafeInteger(p3);
}

export function compareVersions(left: string, right: string): number {
  const parts = (val: string): number[] =>
    val.split('.').map(p => {
      const num = Number.parseInt(p.trim(), 10);
      return Number.isNaN(num) ? 0 : num;
    });
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function validateSignedEnvelope(
  envelope: unknown,
  maxDecodedBytes: number,
): DevUpdateSignedEnvelope {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new DevUpdateVerificationError('invalid-envelope', 'Envelope must be a JSON object');
  }
  const env = envelope as Record<string, unknown>;
  assertExactKeys(env, ['keyId', 'payloadBase64', 'signatureBase64'], 'signed envelope');

  if (typeof env.keyId !== 'string' || env.keyId.trim().length === 0) {
    throw new DevUpdateVerificationError('invalid-key-id', 'Envelope keyId must be a non-empty string');
  }
  if (typeof env.payloadBase64 !== 'string' || !isCanonicalBase64(env.payloadBase64)) {
    throw new DevUpdateVerificationError('invalid-payload-base64', 'Envelope payloadBase64 must be canonical base64');
  }
  if (typeof env.signatureBase64 !== 'string' || !isCanonicalBase64(env.signatureBase64)) {
    throw new DevUpdateVerificationError('invalid-signature-base64', 'Envelope signatureBase64 must be canonical base64');
  }

  const payloadBuf = Buffer.from(env.payloadBase64, 'base64');
  if (payloadBuf.length > maxDecodedBytes) {
    throw new DevUpdateVerificationError(
      'payload-size-limit-exceeded',
      `Decoded payload size ${payloadBuf.length} exceeds limit of ${maxDecodedBytes} bytes`,
    );
  }

  const sigBuf = Buffer.from(env.signatureBase64, 'base64');
  if (sigBuf.length !== 64) {
    throw new DevUpdateVerificationError(
      'invalid-signature-length',
      `Ed25519 signature must decode to 64 bytes, got ${sigBuf.length}`,
    );
  }

  return {
    keyId: env.keyId,
    payloadBase64: env.payloadBase64,
    signatureBase64: env.signatureBase64,
  };
}

/**
 * Verify an Ed25519 signature against exact domain bytes + raw UTF-8 payload bytes.
 */
export function verifyEd25519Signature(
  domain: string,
  rawPayload: string | Buffer,
  signatureBase64: string,
  publicKeyPemOrDer?: string | Buffer | null,
): boolean {
  if (!publicKeyPemOrDer) {
    // Fail closed: public key absent
    return false;
  }
  if (!isCanonicalBase64(signatureBase64)) {
    return false;
  }

  const sigBuf = Buffer.from(signatureBase64, 'base64');
  if (sigBuf.length !== 64) {
    return false;
  }

  let keyObject: crypto.KeyObject;
  try {
    if (typeof publicKeyPemOrDer === 'string') {
      if (publicKeyPemOrDer.startsWith('-----BEGIN PUBLIC KEY-----')) {
        keyObject = crypto.createPublicKey(publicKeyPemOrDer);
      } else {
        // Base64-encoded DER SPKI
        const derBuf = Buffer.from(publicKeyPemOrDer.trim(), 'base64');
        keyObject = crypto.createPublicKey({ key: derBuf, format: 'der', type: 'spki' });
      }
    } else {
      // Buffer
      if (publicKeyPemOrDer.length === 32) {
        // Raw 32-byte Ed25519 public key -> prefix with 12-byte SPKI header
        const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
        const derBuf = Buffer.concat([spkiPrefix, publicKeyPemOrDer]);
        keyObject = crypto.createPublicKey({ key: derBuf, format: 'der', type: 'spki' });
      } else {
        keyObject = crypto.createPublicKey({ key: publicKeyPemOrDer, format: 'der', type: 'spki' });
      }
    }
  } catch {
    return false;
  }

  if (keyObject.asymmetricKeyType !== 'ed25519') {
    return false;
  }

  const domainBuf = Buffer.from(domain, 'utf8');
  const payloadBuf = typeof rawPayload === 'string' ? Buffer.from(rawPayload, 'utf8') : rawPayload;
  const data = Buffer.concat([domainBuf, payloadBuf]);

  try {
    return crypto.verify(null, data, keyObject, sigBuf);
  } catch {
    return false;
  }
}

export function validateInstallerDownloadUrl(rawUrl: string, releaseId: string, fileName: string): boolean {
  if (typeof rawUrl !== 'string' || typeof releaseId !== 'string' || typeof fileName !== 'string') {
    return false;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
    return false;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName) || !fileName.toLowerCase().endsWith('.exe')) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.origin !== DEV_UPDATE_FEED_URL) return false;
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port) return false;
  if (parsed.search || parsed.hash) return false;

  const expectedPath = `/downloads/${releaseId}/${fileName}`;
  if (parsed.pathname !== expectedPath) return false;

  return true;
}

export function validateReleasePayload(payload: unknown): DevUpdateReleasePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DevUpdateVerificationError('invalid-release-payload', 'Release payload must be an object');
  }
  const p = payload as Record<string, unknown>;

  const allowedKeys = [
    'schemaVersion',
    'product',
    'appId',
    'channel',
    'platform',
    'arch',
    'packageType',
    'releaseId',
    'version',
    'sourceCommit',
    'fileName',
    'size',
    'sha256',
    'url',
    'publishedAt',
    'changeLog',
    'offlineInstallAllowed',
  ] as const;
  assertExactKeys(p, allowedKeys, 'release payload');

  if (p.schemaVersion !== 1) {
    throw new DevUpdateVerificationError('unsupported-schema-version', `Unsupported release schemaVersion: ${p.schemaVersion}`);
  }
  if (!validateDevScope(p)) {
    throw new DevUpdateVerificationError(APP_UPDATE_DEV_SCOPE_MISMATCH_ERROR, 'Release scope mismatch');
  }
  if (typeof p.releaseId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(p.releaseId)) {
    throw new DevUpdateVerificationError('invalid-release-id', 'Invalid releaseId format');
  }
  if (typeof p.version !== 'string' || !validateDevVersion(p.version)) {
    throw new DevUpdateVerificationError('invalid-version', `Invalid version format: ${p.version}`);
  }
  if (typeof p.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(p.sourceCommit)) {
    throw new DevUpdateVerificationError('invalid-source-commit', 'Invalid sourceCommit format (must be 40 hex chars)');
  }
  if (typeof p.fileName !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(p.fileName) || !p.fileName.toLowerCase().endsWith('.exe')) {
    throw new DevUpdateVerificationError('invalid-file-name', 'Invalid fileName');
  }
  if (typeof p.size !== 'number' || !Number.isSafeInteger(p.size) || p.size <= 0 || p.size > MAX_INSTALLER_BYTES) {
    throw new DevUpdateVerificationError('invalid-size', `Invalid installer size: ${p.size}`);
  }
  if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) {
    throw new DevUpdateVerificationError('invalid-sha256', 'Invalid SHA256 (must be 64 lowercase hex chars)');
  }
  if (typeof p.url !== 'string' || !validateInstallerDownloadUrl(p.url, p.releaseId, p.fileName)) {
    throw new DevUpdateVerificationError(APP_UPDATE_DEV_UNTRUSTED_ERROR, `Installer URL rejected by policy: ${p.url}`);
  }
  if (typeof p.publishedAt !== 'number' || !Number.isSafeInteger(p.publishedAt) || p.publishedAt <= 0) {
    throw new DevUpdateVerificationError('invalid-published-at', 'Invalid publishedAt');
  }
  if (p.offlineInstallAllowed !== true) {
    throw new DevUpdateVerificationError('invalid-offline-flag', 'offlineInstallAllowed must be true');
  }

  // changeLog validation: strictly { zh: { title, content: string[] }, en: { title, content: string[] } }
  if (!p.changeLog || typeof p.changeLog !== 'object' || Array.isArray(p.changeLog)) {
    throw new DevUpdateVerificationError('invalid-changelog', 'changeLog must be an object');
  }
  const cl = p.changeLog as Record<string, unknown>;
  assertExactKeys(cl, ['zh', 'en'], 'changeLog');
  for (const lang of ['zh', 'en'] as const) {
    const entry = cl[lang];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DevUpdateVerificationError('invalid-changelog-entry', `changeLog.${lang} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    assertExactKeys(e, ['title', 'content'], `changeLog.${lang}`);
    if (typeof e.title !== 'string') {
      throw new DevUpdateVerificationError('invalid-changelog-title', `changeLog.${lang}.title must be string`);
    }
    if (!Array.isArray(e.content) || !e.content.every(item => typeof item === 'string')) {
      throw new DevUpdateVerificationError('invalid-changelog-content', `changeLog.${lang}.content must be string array`);
    }
  }

  return payload as DevUpdateReleasePayload;
}

export function validateChannelPayload(payload: unknown): DevUpdateChannelPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DevUpdateVerificationError('invalid-channel-payload', 'Channel payload must be an object');
  }
  const p = payload as Record<string, unknown>;

  const allowedKeys = [
    'schemaVersion',
    'product',
    'appId',
    'channel',
    'platform',
    'arch',
    'packageType',
    'nonce',
    'revision',
    'issuedAt',
    'expiresAt',
    'latestRelease',
    'candidate',
  ] as const;
  assertExactKeys(p, allowedKeys, 'channel payload');

  if (p.schemaVersion !== 1) {
    throw new DevUpdateVerificationError('unsupported-schema-version', `Unsupported channel schemaVersion: ${p.schemaVersion}`);
  }
  if (!validateDevScope(p)) {
    throw new DevUpdateVerificationError(APP_UPDATE_DEV_SCOPE_MISMATCH_ERROR, 'Channel scope mismatch');
  }
  if (typeof p.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(p.nonce)) {
    throw new DevUpdateVerificationError('invalid-nonce', 'Nonce must be 32 lowercase hex chars');
  }
  if (typeof p.revision !== 'number' || !Number.isSafeInteger(p.revision) || p.revision < 0) {
    throw new DevUpdateVerificationError('invalid-revision', 'Channel revision must be non-negative integer');
  }
  if (typeof p.issuedAt !== 'number' || !Number.isSafeInteger(p.issuedAt) || p.issuedAt <= 0) {
    throw new DevUpdateVerificationError('invalid-issued-at', 'Channel issuedAt must be positive integer');
  }
  if (typeof p.expiresAt !== 'number' || !Number.isSafeInteger(p.expiresAt) || p.expiresAt < (p.issuedAt as number)) {
    throw new DevUpdateVerificationError('invalid-expires-at', 'Channel expiresAt must be >= issuedAt');
  }

  let latestRelease: DevUpdateSignedEnvelope | null = null;
  if (p.latestRelease !== null) {
    latestRelease = validateSignedEnvelope(p.latestRelease, MAX_RELEASE_PAYLOAD_BYTES);
  }

  let candidate: DevUpdateCandidateReceipt | null = null;
  if (p.candidate !== null) {
    if (!p.candidate || typeof p.candidate !== 'object' || Array.isArray(p.candidate)) {
      throw new DevUpdateVerificationError('invalid-candidate', 'Candidate must be null or object');
    }
    const c = p.candidate as Record<string, unknown>;
    assertExactKeys(c, ['releaseId', 'sha256', 'status'], 'candidate receipt');
    if (typeof c.releaseId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c.releaseId)) {
      throw new DevUpdateVerificationError('invalid-candidate-release-id', 'Invalid candidate releaseId');
    }
    if (typeof c.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.sha256)) {
      throw new DevUpdateVerificationError('invalid-candidate-sha256', 'Invalid candidate sha256');
    }
    const status = c.status as DevUpdateCandidateStatus;
    if (status !== 'allowed' && status !== 'revoked' && status !== 'unrecognized') {
      throw new DevUpdateVerificationError('invalid-candidate-status', `Invalid candidate status: ${status}`);
    }
    candidate = {
      releaseId: c.releaseId,
      sha256: c.sha256,
      status,
    };
  }

  return {
    schemaVersion: 1,
    product: DEV_UPDATE_SCOPE.product,
    appId: DEV_UPDATE_SCOPE.appId,
    channel: DEV_UPDATE_SCOPE.channel,
    platform: DEV_UPDATE_SCOPE.platform,
    arch: DEV_UPDATE_SCOPE.arch,
    packageType: DEV_UPDATE_SCOPE.packageType,
    nonce: p.nonce,
    revision: p.revision,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    latestRelease,
    candidate,
  };
}

/**
 * Classify whether an error is eligible for offline fallback.
 * ONLY timeout, DNS, connect failure, and 502/503/504 HTTP responses are offline-eligible.
 * TLS, cert errors, 4xx, other HTTP errors, signature, protocol, schema failures are fatal.
 */
export function isOfflineEligibleError(error: unknown): boolean {
  if (!error) return false;

  if (error instanceof DevUpdateTransportError) {
    return error.isOfflineEligible;
  }

  if (error instanceof DevUpdateRevokedError || error instanceof DevUpdateVerificationError) {
    return false;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    const name = error.name.toLowerCase();
    const code = (error as { code?: string }).code?.toUpperCase() ?? '';

    // Strict FATAL check: TLS / Certificate errors are NEVER offline eligible!
    if (
      msg.includes('cert_')
      || msg.includes('certificate')
      || msg.includes('tls')
      || msg.includes('ssl')
      || msg.includes('unable_to_verify')
      || code.includes('CERT')
      || code.includes('TLS')
    ) {
      return false;
    }

    // Timeout
    if (name.includes('abort') || name.includes('timeout') || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
      return true;
    }

    // DNS failure
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('getaddrinfo') || msg.includes('err_name_not_resolved')) {
      return true;
    }

    // Connection failure
    if (
      code === 'ECONNREFUSED'
      || code === 'ECONNRESET'
      || code === 'EHOSTUNREACH'
      || code === 'ENETUNREACH'
      || msg.includes('err_connection_refused')
      || msg.includes('err_connection_reset')
      || msg.includes('err_internet_disconnected')
    ) {
      return true;
    }
  }

  return false;
}
