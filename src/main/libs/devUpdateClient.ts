import crypto from 'crypto';
import { session } from 'electron';
import fs from 'fs';

import {
  APP_UPDATE_DEV_OFFLINE_DISALLOWED_ERROR,
  APP_UPDATE_DEV_REVOKED_ERROR,
  APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR,
  APP_UPDATE_DEV_UNTRUSTED_ERROR,
  APP_UPDATE_FILE_INVALID_ERROR,
  type AppUpdateInfo,
} from '../../shared/appUpdate/constants';
import {
  DEV_UPDATE_SCOPE,
  type DevUpdateCandidateRef,
  type DevUpdateChannelCheckRequest,
  type DevUpdateCheckResult,
  type DevUpdateReadyRecord,
  type DevUpdateReleasePayload,
  type DevUpdateSignedEnvelope,
} from '../../shared/appUpdate/devUpdateTypes';
import {
  CHANNEL_EXPIRY_SECONDS,
  CHANNEL_SIGN_DOMAIN,
  CLOCK_TOLERANCE_SECONDS,
  compareVersions,
  DEV_UPDATE_CHANNEL_CHECK_PATH,
  DEV_UPDATE_FEED_URL,
  DevUpdateRevokedError,
  DevUpdateTransportError,
  DevUpdateVerificationError,
  isOfflineEligibleError,
  MAX_METADATA_BYTES,
  parseStrictJsonWithoutDuplicates,
  RELEASE_SIGN_DOMAIN,
  REQUEST_TIMEOUT_MS,
  TRUSTED_DEV_UPDATE_PUBLIC_KEYS,
  validateChannelPayload,
  validateReleasePayload,
  validateSignedEnvelope,
  verifyEd25519Signature,
} from './devUpdateProtocol';
import { DevUpdateTrustStore } from './devUpdateTrustStore';

export interface DevUpdateClientOptions {
  feedUrl?: string;
  trustedKeys?: Record<string, string>;
  trustStore: DevUpdateTrustStore;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  platform?: string;
  arch?: string;
  productName?: string;
  appId?: string;
}

export class DevUpdateClient {
  private readonly feedUrl: string;
  private readonly trustedKeys: Record<string, string>;
  private readonly trustStore: DevUpdateTrustStore;
  private readonly customFetch?: (url: string, init: RequestInit) => Promise<Response>;
  private readonly platform: string;
  private readonly arch: string;
  private readonly productName: string;
  private readonly appId: string;

  constructor(options: DevUpdateClientOptions) {
    this.feedUrl = options.feedUrl ?? DEV_UPDATE_FEED_URL;
    this.trustedKeys = options.trustedKeys ?? TRUSTED_DEV_UPDATE_PUBLIC_KEYS;
    this.trustStore = options.trustStore;
    this.customFetch = options.fetch;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.productName = options.productName ?? 'LobsterAI-Dev';
    this.appId = options.appId ?? 'com.lobsterai.dev.app';
  }

  /**
   * Check if current runtime environment matches the strict Windows x64 Dev identity.
   */
  isDevUpdateEligible(): boolean {
    return (
      this.platform === DEV_UPDATE_SCOPE.platform
      && this.arch === DEV_UPDATE_SCOPE.arch
      && this.productName === DEV_UPDATE_SCOPE.product
      && this.appId === DEV_UPDATE_SCOPE.appId
    );
  }

  private async executeFetch(url: string, init: RequestInit): Promise<Response> {
    const doFetch =
      this.customFetch
      ?? (typeof session?.defaultSession?.fetch === 'function'
        ? session.defaultSession.fetch.bind(session.defaultSession)
        : globalThis.fetch);

    try {
      return await doFetch(url, init);
    } catch (err) {
      const isEligible = isOfflineEligibleError(err);
      const code = (err as { code?: string }).code;
      throw new DevUpdateTransportError(
        `Dev update fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        { isOfflineEligible: isEligible, code },
      );
    }
  }

  private async readBoundedResponseBody(response: Response, maxBytes: number): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    if (response.body && typeof (response.body as any).getReader === 'function') {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore cancel error
            }
            throw new DevUpdateVerificationError(
              'metadata-size-limit-exceeded',
              `Response exceeded size limit of ${maxBytes} bytes`,
            );
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
    } else {
      const arrayBuf = await response.arrayBuffer();
      if (arrayBuf.byteLength > maxBytes) {
        throw new DevUpdateVerificationError(
          'metadata-size-limit-exceeded',
          `Response exceeded size limit of ${maxBytes} bytes`,
        );
      }
      chunks.push(Buffer.from(arrayBuf));
    }

    const completeBuffer = Buffer.concat(chunks);
    const str = completeBuffer.toString('utf8');
    if (!Buffer.from(str, 'utf8').equals(completeBuffer)) {
      throw new DevUpdateVerificationError('invalid-utf8-bytes', 'Response body contains invalid UTF-8 bytes');
    }
    return str;
  }

  async checkForUpdate(
    currentVersion: string,
    candidate?: DevUpdateCandidateRef | null,
  ): Promise<DevUpdateCheckResult> {
    const nonce = crypto.randomBytes(16).toString('hex');
    const highestRevision = this.trustStore.getHighestRevision();

    const requestBody: DevUpdateChannelCheckRequest = {
      schemaVersion: 1,
      product: DEV_UPDATE_SCOPE.product,
      appId: DEV_UPDATE_SCOPE.appId,
      channel: DEV_UPDATE_SCOPE.channel,
      platform: DEV_UPDATE_SCOPE.platform,
      arch: DEV_UPDATE_SCOPE.arch,
      packageType: DEV_UPDATE_SCOPE.packageType,
      nonce,
      currentVersion,
      highestRevision,
      candidate: candidate ? { releaseId: candidate.releaseId, sha256: candidate.sha256.toLowerCase() } : null,
    };

    const checkUrl = `${this.feedUrl}${DEV_UPDATE_CHANNEL_CHECK_PATH}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    let responseText: string;
    try {
      response = await this.executeFetch(checkUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        redirect: 'error',
      });

      if (!response.ok) {
        const isEligible = response.status === 502 || response.status === 503 || response.status === 504;
        throw new DevUpdateTransportError(
          `Dev update server returned status ${response.status}`,
          { isOfflineEligible: isEligible, statusCode: response.status },
        );
      }

      // Bounded stream reader under the 10s timer
      responseText = await this.readBoundedResponseBody(response, MAX_METADATA_BYTES);
    } catch (err) {
      if (err instanceof DevUpdateTransportError || err instanceof DevUpdateVerificationError) {
        throw err;
      }
      const isEligible = isOfflineEligibleError(err);
      const code = (err as { code?: string }).code;
      throw new DevUpdateTransportError(
        `Dev update request failed: ${err instanceof Error ? err.message : String(err)}`,
        { isOfflineEligible: isEligible, code },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const parsedEnvelope = parseStrictJsonWithoutDuplicates(responseText);
    const channelEnvelope = validateSignedEnvelope(parsedEnvelope, MAX_METADATA_BYTES);

    const channelKey = this.trustedKeys[channelEnvelope.keyId];
    if (!channelKey) {
      throw new DevUpdateVerificationError('unknown-channel-key-id', `Unknown keyId: ${channelEnvelope.keyId}`);
    }

    const rawChannelBuf = Buffer.from(channelEnvelope.payloadBase64, 'base64');
    const rawChannel = rawChannelBuf.toString('utf8');
    if (!Buffer.from(rawChannel, 'utf8').equals(rawChannelBuf)) {
      throw new DevUpdateVerificationError('invalid-utf8-bytes', 'Channel payload contains invalid UTF-8 bytes');
    }
    const isChannelSigValid = verifyEd25519Signature(
      CHANNEL_SIGN_DOMAIN,
      rawChannelBuf,
      channelEnvelope.signatureBase64,
      channelKey,
    );
    if (!isChannelSigValid) {
      throw new DevUpdateVerificationError(
        APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR,
        'Channel envelope Ed25519 signature verification failed',
      );
    }

    const parsedChannel = parseStrictJsonWithoutDuplicates(rawChannel);
    const channelPayload = validateChannelPayload(parsedChannel);

    // Verify request nonce binding
    if (channelPayload.nonce !== nonce) {
      throw new DevUpdateVerificationError('nonce-mismatch', 'Channel response nonce does not match request nonce');
    }

    // Monotonic revision check against live highest revision
    const liveHighestRevision = this.trustStore.getHighestRevision();
    if (channelPayload.revision < Math.max(highestRevision, liveHighestRevision)) {
      throw new DevUpdateVerificationError(
        'revision-rollback',
        `Channel revision ${channelPayload.revision} is lower than local highestRevision ${Math.max(highestRevision, liveHighestRevision)}`,
      );
    }

    // Timestamp validity window check
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      nowSec < channelPayload.issuedAt - CLOCK_TOLERANCE_SECONDS
      || nowSec > channelPayload.expiresAt + CLOCK_TOLERANCE_SECONDS
    ) {
      throw new DevUpdateVerificationError(
        'channel-expired',
        `Channel payload timing invalid: now=${nowSec}, issuedAt=${channelPayload.issuedAt}, expiresAt=${channelPayload.expiresAt}`,
      );
    }
    if (channelPayload.expiresAt - channelPayload.issuedAt > CHANNEL_EXPIRY_SECONDS + CLOCK_TOLERANCE_SECONDS) {
      throw new DevUpdateVerificationError('channel-expiry-range-too-large', 'Channel validity window exceeds max allowed');
    }

    // Strict request/response candidate echo and symmetry check
    if (candidate) {
      if (!channelPayload.candidate) {
        throw new DevUpdateVerificationError(
          'candidate-echo-missing',
          'Candidate was requested but server returned candidate: null',
        );
      }
      const echoed = channelPayload.candidate;
      if (
        echoed.releaseId !== candidate.releaseId
        || echoed.sha256.toLowerCase() !== candidate.sha256.toLowerCase()
      ) {
        throw new DevUpdateVerificationError(
          'candidate-echo-mismatch',
          `Server echoed mismatching candidate: requested (${candidate.releaseId}, ${candidate.sha256}), got (${echoed.releaseId}, ${echoed.sha256})`,
        );
      }
      if (echoed.status === 'revoked' || echoed.status === 'unrecognized') {
        this.trustStore.recordStickyDeny(
          echoed.releaseId,
          echoed.sha256,
          echoed.status,
          channelPayload.revision,
          channelEnvelope,
        );
      }
    } else if (channelPayload.candidate !== null) {
      throw new DevUpdateVerificationError(
        'unexpected-candidate-response',
        'No candidate was requested but server returned non-null candidate',
      );
    }

    // Persist highest revision
    this.trustStore.recordHighestRevision(channelPayload.revision);

    // If latestRelease is present in channel
    if (channelPayload.latestRelease) {
      const releaseEnvelope = channelPayload.latestRelease;
      const releaseKey = this.trustedKeys[releaseEnvelope.keyId];
      if (!releaseKey) {
        throw new DevUpdateVerificationError('unknown-release-key-id', `Unknown keyId: ${releaseEnvelope.keyId}`);
      }

      const rawReleaseBuf = Buffer.from(releaseEnvelope.payloadBase64, 'base64');
      const rawRelease = rawReleaseBuf.toString('utf8');
      if (!Buffer.from(rawRelease, 'utf8').equals(rawReleaseBuf)) {
        throw new DevUpdateVerificationError('invalid-utf8-bytes', 'Release payload contains invalid UTF-8 bytes');
      }
      const isReleaseSigValid = verifyEd25519Signature(
        RELEASE_SIGN_DOMAIN,
        rawReleaseBuf,
        releaseEnvelope.signatureBase64,
        releaseKey,
      );
      if (!isReleaseSigValid) {
        throw new DevUpdateVerificationError(
          APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR,
          'Release envelope Ed25519 signature verification failed',
        );
      }

      const parsedRelease = parseStrictJsonWithoutDuplicates(rawRelease);
      const releasePayload = validateReleasePayload(parsedRelease);

      // Check if release is sticky denied
      if (this.trustStore.isDenied(releasePayload.releaseId, releasePayload.sha256)) {
        return {
          updateFound: false,
          info: null,
          releasePayload: null,
          releaseEnvelope: null,
          channelEnvelope,
          channelRevision: channelPayload.revision,
          requestNonce: nonce,
          channelIssuedAt: channelPayload.issuedAt,
          channelExpiresAt: channelPayload.expiresAt,
        };
      }

      // Check if release version is strictly newer than current installed version
      const isNewer = compareVersions(releasePayload.version, currentVersion) > 0;
      if (!isNewer) {
        return {
          updateFound: false,
          info: null,
          releasePayload: null,
          releaseEnvelope: null,
          channelEnvelope,
          channelRevision: channelPayload.revision,
          requestNonce: nonce,
          channelIssuedAt: channelPayload.issuedAt,
          channelExpiresAt: channelPayload.expiresAt,
        };
      }

      const info: AppUpdateInfo = {
        latestVersion: releasePayload.version,
        date: new Date(releasePayload.publishedAt * 1000).toISOString(),
        changeLog: releasePayload.changeLog,
        url: releasePayload.url,
        dev: {
          releaseId: releasePayload.releaseId,
          sha256: releasePayload.sha256,
          size: releasePayload.size,
          fileName: releasePayload.fileName,
          sourceCommit: releasePayload.sourceCommit,
          publishedAt: releasePayload.publishedAt,
          highestRevision: channelPayload.revision,
        },
      };

      return {
        updateFound: true,
        info,
        releasePayload,
        releaseEnvelope,
        channelEnvelope,
        channelRevision: channelPayload.revision,
        requestNonce: nonce,
        channelIssuedAt: channelPayload.issuedAt,
        channelExpiresAt: channelPayload.expiresAt,
      };
    }

    return {
      updateFound: false,
      info: null,
      releasePayload: null,
      releaseEnvelope: null,
      channelEnvelope,
      channelRevision: channelPayload.revision,
      requestNonce: nonce,
      channelIssuedAt: channelPayload.issuedAt,
      channelExpiresAt: channelPayload.expiresAt,
    };
  }

  /**
   * Pre-download candidate authorization roundtrip.
   * When latestRelease is discovered with candidate=null, this method queries
   * the server with candidate={releaseId, sha256} to obtain an explicit signed
   * allowed receipt before download starts.
   */
  async authorizeCandidateForDownload(
    release: DevUpdateReleasePayload,
    currentVersion: string,
  ): Promise<DevUpdateCheckResult> {
    const candidateRef: DevUpdateCandidateRef = {
      releaseId: release.releaseId,
      sha256: release.sha256.toLowerCase(),
    };
    const result = await this.checkForUpdate(currentVersion, candidateRef);
    return result;
  }

  async verifyDownloadedFile(
    filePath: string,
    release: { size: number; sha256: string },
  ): Promise<boolean> {
    if (!fs.existsSync(filePath)) return false;

    try {
      const stat = fs.statSync(filePath);
      if (stat.size !== release.size) return false;
    } catch {
      return false;
    }

    const computedHash = await new Promise<string | null>((resolve) => {
      try {
        const hashStream = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hashStream.update(chunk));
        stream.on('end', () => resolve(hashStream.digest('hex').toLowerCase()));
        stream.on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });

    return computedHash === release.sha256.toLowerCase();
  }

  async acceptDownloadedReady(params: {
    filePath: string;
    fileSize: number;
    fileHash: string;
    release: DevUpdateReleasePayload;
    releaseEnvelope: DevUpdateSignedEnvelope;
    channelEnvelope: DevUpdateSignedEnvelope;
    requestNonce: string;
    channelRevision: number;
    verifiedAt: number;
    channelIssuedAt: number;
    channelExpiresAt: number;
  }): Promise<void> {
    const normHash = params.fileHash.toLowerCase();
    if (this.trustStore.isDenied(params.release.releaseId, normHash)) {
      throw new DevUpdateRevokedError(params.release.releaseId, normHash, 'revoked');
    }

    // Strict gate: verify channel envelope contains valid candidate matching this release with status 'allowed'
    const rawChannelBuf = Buffer.from(params.channelEnvelope.payloadBase64, 'base64');
    const rawChannelStr = rawChannelBuf.toString('utf8');
    if (!Buffer.from(rawChannelStr, 'utf8').equals(rawChannelBuf)) {
      throw new DevUpdateVerificationError('invalid-utf8-bytes', 'Channel payload contains invalid UTF-8 bytes');
    }
    const parsedChannel = parseStrictJsonWithoutDuplicates(rawChannelStr);
    const channelPayload = validateChannelPayload(parsedChannel);

    if (!channelPayload.candidate) {
      throw new DevUpdateVerificationError('missing-candidate', 'Channel envelope for ready download has null candidate');
    }
    if (
      channelPayload.candidate.releaseId !== params.release.releaseId
      || channelPayload.candidate.sha256.toLowerCase() !== normHash
      || channelPayload.candidate.status !== 'allowed'
    ) {
      throw new DevUpdateVerificationError(
        'candidate-not-allowed',
        `Channel envelope candidate is not allowed: ${JSON.stringify(channelPayload.candidate)}`,
      );
    }

    const readyRecord: DevUpdateReadyRecord = {
      version: params.release.version,
      filePath: params.filePath,
      fileHash: normHash,
      fileSize: params.fileSize,
      releasePayload: params.release,
      releaseEnvelope: params.releaseEnvelope,
      channelEnvelope: params.channelEnvelope,
      requestNonce: params.requestNonce,
      channelRevision: params.channelRevision,
      verifiedAt: params.verifiedAt,
      channelIssuedAt: params.channelIssuedAt,
      channelExpiresAt: params.channelExpiresAt,
      installAttempted: false,
    };

    this.trustStore.saveReadyCandidate(readyRecord);
  }

  async preInstallVerification(params: {
    releaseId: string;
    sha256: string;
    currentVersion: string;
    filePath: string;
    expectedSize: number;
  }): Promise<{ offlineFallback: boolean }> {
    const normHash = params.sha256.toLowerCase();

    // Synchronous pre-check: ensure candidate is not denied and has basic record
    this.trustStore.assertCanInstall(params.releaseId, normHash);

    let onlineResult: DevUpdateCheckResult | null = null;
    try {
      onlineResult = await this.checkForUpdate(params.currentVersion, {
        releaseId: params.releaseId,
        sha256: normHash,
      });
    } catch (err) {
      // Strict security gate: NO generic catch permits offline!
      if (!isOfflineEligibleError(err)) {
        // Fatal error (e.g. TLS, 4xx, 500, cert error, schema error)
        throw err;
      }

      // Offline-eligible branch: verified prior allowed receipt MUST exist
      const receipt = this.trustStore.getAllowedReceipt(params.releaseId, normHash);
      if (!receipt) {
        throw new Error(APP_UPDATE_DEV_OFFLINE_DISALLOWED_ERROR);
      }
      if (this.trustStore.isDenied(params.releaseId, normHash)) {
        throw new Error(APP_UPDATE_DEV_REVOKED_ERROR);
      }

      // Re-verify installer bytes on disk
      const isFileIntact = await this.verifyDownloadedFile(params.filePath, {
        size: params.expectedSize,
        sha256: normHash,
      });
      if (!isFileIntact) {
        throw new Error(APP_UPDATE_FILE_INVALID_ERROR);
      }

      return { offlineFallback: true };
    }

    // Online check succeeded: check candidate status from server
    if (onlineResult && onlineResult.channelEnvelope) {
      const rawChannelBuf = Buffer.from(onlineResult.channelEnvelope.payloadBase64, 'base64');
      const rawChannel = rawChannelBuf.toString('utf8');
      if (!Buffer.from(rawChannel, 'utf8').equals(rawChannelBuf)) {
        throw new DevUpdateVerificationError('invalid-utf8-bytes', 'Channel payload contains invalid UTF-8 bytes');
      }
      const parsedChannel = parseStrictJsonWithoutDuplicates(rawChannel);
      const channelPayload = validateChannelPayload(parsedChannel);

      if (channelPayload.candidate) {
        const cand = channelPayload.candidate;
        if (cand.releaseId !== params.releaseId || cand.sha256.toLowerCase() !== normHash) {
          throw new DevUpdateVerificationError(
            'candidate-echo-mismatch',
            `Server candidate echo does not match requested candidate: expected (${params.releaseId}, ${normHash}), got (${cand.releaseId}, ${cand.sha256})`,
          );
        }
        if (cand.status === 'revoked' || cand.status === 'unrecognized') {
          this.trustStore.recordStickyDeny(
            cand.releaseId,
            cand.sha256,
            cand.status,
            channelPayload.revision,
            onlineResult.channelEnvelope,
          );
          throw new DevUpdateRevokedError(cand.releaseId, cand.sha256, cand.status);
        }
        if (cand.status === 'allowed') {
          // Server confirmed candidate is allowed
          // Persist highest revision from the confirmed channel payload
          this.trustStore.recordHighestRevision(channelPayload.revision);
          // Re-verify file bytes on disk before launch
          const isFileIntact = await this.verifyDownloadedFile(params.filePath, {
            size: params.expectedSize,
            sha256: normHash,
          });
          if (!isFileIntact) {
            throw new Error(APP_UPDATE_FILE_INVALID_ERROR);
          }
          return { offlineFallback: false };
        }
      }
    }

    throw new DevUpdateVerificationError(
      APP_UPDATE_DEV_UNTRUSTED_ERROR,
      'Online check did not validate candidate as allowed',
    );
  }
}
