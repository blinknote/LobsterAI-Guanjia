import type { AppUpdateInfo } from './constants';

export type DevPlatform = 'win32' | 'darwin';
export type DevArch = 'x64' | 'arm64';
export type DevPackageType = 'nsis-full' | 'dmg';

export function getDevUpdateScope(
  platform: string = process.platform,
  arch: string = process.arch,
) {
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      product: 'LobsterAI-Dev',
      appId: 'com.lobsterai.dev.app',
      channel: 'dev',
      platform: 'darwin',
      arch: 'arm64',
      packageType: 'dmg',
    } as const;
  }
  return {
    product: 'LobsterAI-Dev',
    appId: 'com.lobsterai.dev.app',
    channel: 'dev',
    platform: 'win32',
    arch: 'x64',
    packageType: 'nsis-full',
  } as const;
}

export const DEV_UPDATE_SCOPE = getDevUpdateScope();
export type DevUpdateScope = ReturnType<typeof getDevUpdateScope>;

export interface DevUpdateSignedEnvelope {
  keyId: string;
  payloadBase64: string;
  signatureBase64: string;
}

export interface DevUpdateChangeLogLocale {
  title: string;
  content: string[];
}

export interface DevUpdateChangeLog {
  zh: DevUpdateChangeLogLocale;
  en: DevUpdateChangeLogLocale;
}

export interface DevUpdateReleasePayload {
  schemaVersion: 1;
  product: 'LobsterAI-Dev';
  appId: 'com.lobsterai.dev.app';
  channel: 'dev';
  platform: DevPlatform;
  arch: DevArch;
  packageType: DevPackageType;
  releaseId: string;
  version: string;
  sourceCommit: string;
  fileName: string;
  size: number;
  sha256: string;
  url: string;
  publishedAt: number;
  changeLog: DevUpdateChangeLog;
  offlineInstallAllowed: true;
}

export type DevUpdateCandidateStatus = 'allowed' | 'revoked' | 'unrecognized';

export interface DevUpdateCandidateRef {
  releaseId: string;
  sha256: string;
}

export interface DevUpdateCandidateReceipt {
  releaseId: string;
  sha256: string;
  status: DevUpdateCandidateStatus;
}

export interface DevUpdateChannelCheckRequest {
  schemaVersion: 1;
  product: 'LobsterAI-Dev';
  appId: 'com.lobsterai.dev.app';
  channel: 'dev';
  platform: DevPlatform;
  arch: DevArch;
  packageType: DevPackageType;
  nonce: string;
  currentVersion: string;
  highestRevision: number;
  candidate: DevUpdateCandidateRef | null;
}

export interface DevUpdateChannelPayload {
  schemaVersion: 1;
  product: 'LobsterAI-Dev';
  appId: 'com.lobsterai.dev.app';
  channel: 'dev';
  platform: DevPlatform;
  arch: DevArch;
  packageType: DevPackageType;
  nonce: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  latestRelease: DevUpdateSignedEnvelope | null;
  candidate: DevUpdateCandidateReceipt | null;
}

export interface DevUpdateContext {
  releaseId: string;
  sha256: string;
  size: number;
  fileName: string;
  sourceCommit: string;
  publishedAt: number;
  highestRevision: number;
}

export interface DevUpdateCheckResult {
  updateFound: boolean;
  info: AppUpdateInfo | null;
  releasePayload: DevUpdateReleasePayload | null;
  releaseEnvelope: DevUpdateSignedEnvelope | null;
  channelEnvelope: DevUpdateSignedEnvelope | null;
  channelRevision: number;
  requestNonce: string;
  channelIssuedAt: number;
  channelExpiresAt: number;
}

export interface DevUpdateAllowedReceiptRecord {
  releaseId: string;
  sha256: string;
  version: string;
  rawReleasePayload: string;
  releaseEnvelope: DevUpdateSignedEnvelope;
  channelEnvelope: DevUpdateSignedEnvelope;
  requestNonce: string;
  channelRevision: number;
  verifiedAt: number;
  channelIssuedAt: number;
  channelExpiresAt: number;
}

export interface DevUpdateReadyRecord {
  version: string;
  filePath: string;
  fileHash: string;
  fileSize: number;
  releasePayload: DevUpdateReleasePayload;
  releaseEnvelope: DevUpdateSignedEnvelope;
  channelEnvelope: DevUpdateSignedEnvelope;
  requestNonce: string;
  channelRevision: number;
  verifiedAt: number;
  channelIssuedAt: number;
  channelExpiresAt: number;
  installAttempted: boolean;
}

export interface DevUpdateRestoredReady {
  record: DevUpdateReadyRecord;
  info: AppUpdateInfo;
}
