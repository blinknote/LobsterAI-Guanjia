import Database from 'better-sqlite3';
import crypto from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  APP_UPDATE_DEV_INSTALL_LOCKED_ERROR,
  APP_UPDATE_DEV_REVOKED_ERROR,
  APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR,
  APP_UPDATE_DEV_STORE_CORRUPTED_ERROR,
  APP_UPDATE_DEV_UNTRUSTED_ERROR,
  type AppUpdateInfo,
} from '../../shared/appUpdate/constants';
import {
  type DevUpdateAllowedReceiptRecord,
  type DevUpdateReadyRecord,
  type DevUpdateReleasePayload,
  type DevUpdateRestoredReady,
  type DevUpdateSignedEnvelope,
  getDevUpdateScope,
} from '../../shared/appUpdate/devUpdateTypes';
import {
  CHANNEL_SIGN_DOMAIN,
  CLOCK_TOLERANCE_SECONDS,
  DevUpdateRevokedError,
  DevUpdateVerificationError,
  parseStrictJsonWithoutDuplicates,
  RELEASE_SIGN_DOMAIN,
  TRUSTED_DEV_UPDATE_PUBLIC_KEYS,
  validateChannelPayload,
  validateDevScope,
  validateReleasePayload,
  verifyEd25519Signature,
} from './devUpdateProtocol';

export interface DevUpdateTrustStoreOptions {
  dbPath?: string;
  userDataPath?: string;
  trustedKeys?: Record<string, string>;
}

interface ReadyRow {
  id: number;
  version: string;
  file_path: string;
  file_hash: string;
  file_size: number;
  release_id: string;
  raw_release_payload: string;
  release_envelope_json: string;
  channel_envelope_json: string;
  request_nonce: string;
  channel_revision: number;
  verified_at: number;
  channel_issued_at: number;
  channel_expires_at: number;
  install_attempted: number;
}

interface AllowedReceiptRow {
  release_id: string;
  sha256: string;
  version: string;
  raw_release_payload: string;
  release_envelope_json: string;
  channel_envelope_json: string;
  request_nonce: string;
  channel_revision: number;
  verified_at: number;
  channel_issued_at: number;
  channel_expires_at: number;
}

export class DevUpdateTrustStore {
  private db: Database.Database;
  private dbPath: string;
  private isInstallLocked = false;
  private isCorruptedLatch = false;
  private trustedKeys: Record<string, string>;

  constructor(options?: DevUpdateTrustStoreOptions) {
    this.trustedKeys = options?.trustedKeys ?? TRUSTED_DEV_UPDATE_PUBLIC_KEYS;

    if (options?.dbPath) {
      this.dbPath = options.dbPath;
    } else {
      const basePath =
        options?.userDataPath ?? (typeof app?.getPath === 'function' ? app.getPath('userData') : undefined);
      if (!basePath) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Cannot determine valid userData path`);
      }
      this.dbPath = path.join(basePath, 'dev-update-trust.sqlite3');
    }

    try {
      const dir = path.dirname(this.dbPath);
      let isNewDb = false;

      // Check parent directory with lstat
      try {
        const dirStat = fs.lstatSync(dir);
        if (!dirStat.isDirectory()) {
          this.isCorruptedLatch = true;
          throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Database parent path is not a directory`);
        }
      } catch (dirErr: any) {
        if (dirErr?.code === 'ENOENT') {
          fs.mkdirSync(dir, { recursive: true });
        } else {
          this.isCorruptedLatch = true;
          throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Failed to access parent directory: ${String(dirErr)}`);
        }
      }

      // Check db file with lstat
      try {
        const dbStat = fs.lstatSync(this.dbPath);
        if (!dbStat.isFile()) {
          this.isCorruptedLatch = true;
          throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Database path is not a regular file`);
        }
        isNewDb = false;
      } catch (dbErr: any) {
        if (dbErr?.code === 'ENOENT') {
          isNewDb = true;
        } else {
          this.isCorruptedLatch = true;
          throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Failed to stat database file: ${String(dbErr)}`);
        }
      }

      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');

      if (isNewDb) {
        this.initFreshSchema();
      } else {
        this.verifyExistingDatabase();
      }
    } catch (err) {
      this.isCorruptedLatch = true;
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Failed to initialize trust store: ${String(err)}`);
    }
  }

  private assertNotCorrupted(): void {
    if (this.isCorruptedLatch) {
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Trust store is latched in corrupted state`);
    }
  }

  private verifyExistingDatabase(): void {
    // 1. Run PRAGMA integrity_check
    const integrity = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (!integrity || integrity.length === 0 || integrity[0]?.integrity_check !== 'ok') {
      this.isCorruptedLatch = true;
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: SQLite integrity_check failed`);
    }

    // 2. Verify required tables exist
    const requiredTables = ['metadata', 'sticky_denies', 'allowed_receipts', 'ready_candidate'];
    const tableCheckStmt = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?");
    for (const table of requiredTables) {
      const row = tableCheckStmt.get(table);
      if (!row) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Missing required table "${table}" in existing store`);
      }
    }

    // 3. Verify metadata records
    const metaStmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');

    const schemaVersionRow = metaStmt.get('schema_version') as { value: string } | undefined;
    if (!schemaVersionRow || schemaVersionRow.value !== '1') {
      this.isCorruptedLatch = true;
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Invalid or missing schema_version in metadata`);
    }

    const scopeRow = metaStmt.get('scope') as { value: string } | undefined;
    if (!scopeRow) {
      this.isCorruptedLatch = true;
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Missing scope in metadata`);
    }
    try {
      const parsedScope = JSON.parse(scopeRow.value);
      if (!validateDevScope(parsedScope)) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Scope mismatch in metadata`);
      }
    } catch {
      this.isCorruptedLatch = true;
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Corrupted scope JSON in metadata`);
    }

    const highestRevRow = metaStmt.get('highest_revision') as { value: string } | undefined;
    if (
      !highestRevRow
      || !/^(0|[1-9]\d*)$/.test(highestRevRow.value)
      || !Number.isSafeInteger(Number(highestRevRow.value))
    ) {
      this.isCorruptedLatch = true;
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Invalid highest_revision in metadata`);
    }
  }

  private initFreshSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sticky_denies (
        release_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        denied_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        channel_revision INTEGER,
        channel_envelope_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sticky_denies_sha256 ON sticky_denies(sha256);

      CREATE TABLE IF NOT EXISTS allowed_receipts (
        release_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        version TEXT NOT NULL,
        raw_release_payload TEXT NOT NULL,
        release_envelope_json TEXT NOT NULL,
        channel_envelope_json TEXT NOT NULL,
        request_nonce TEXT NOT NULL,
        channel_revision INTEGER NOT NULL,
        verified_at INTEGER NOT NULL,
        channel_issued_at INTEGER NOT NULL,
        channel_expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ready_candidate (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        release_id TEXT NOT NULL,
        raw_release_payload TEXT NOT NULL,
        release_envelope_json TEXT NOT NULL,
        channel_envelope_json TEXT NOT NULL,
        request_nonce TEXT NOT NULL,
        channel_revision INTEGER NOT NULL,
        verified_at INTEGER NOT NULL,
        channel_issued_at INTEGER NOT NULL,
        channel_expires_at INTEGER NOT NULL,
        install_attempted INTEGER NOT NULL DEFAULT 0
      );
    `);

    const initMeta = this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    const initTx = this.db.transaction(() => {
      initMeta.run('schema_version', '1');
      initMeta.run('scope', JSON.stringify(getDevUpdateScope()));
      initMeta.run('highest_revision', '0');
    });
    initTx();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore close error
    }
  }

  getHighestRevision(): number {
    this.assertNotCorrupted();
    try {
      const stmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
      const row = stmt.get('highest_revision') as { value: string } | undefined;
      if (!row || typeof row.value !== 'string') {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Missing highest_revision metadata`);
      }
      if (!/^(0|[1-9]\d*)$/.test(row.value) || !Number.isSafeInteger(Number(row.value))) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Corrupted highest_revision value: ${row.value}`);
      }
      return Number(row.value);
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  recordHighestRevision(revision: number): void {
    this.assertNotCorrupted();
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new DevUpdateVerificationError('invalid-revision', `Invalid revision value: ${revision}`);
    }
    const current = this.getHighestRevision();
    if (revision < current) {
      throw new DevUpdateVerificationError(
        'revision-rollback',
        `Attempt to record revision ${revision} which is lower than current highest ${current}`,
      );
    }
    if (revision === current) return;

    try {
      const stmt = this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
      stmt.run('highest_revision', revision.toString());
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  isDenied(releaseId: string, sha256: string): boolean {
    this.assertNotCorrupted();
    try {
      const stmt = this.db.prepare('SELECT 1 FROM sticky_denies WHERE release_id = ? OR sha256 = ?');
      const row = stmt.get(releaseId, sha256.toLowerCase());
      return row != null;
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  recordStickyDeny(
    releaseId: string,
    sha256: string,
    reason: string,
    channelRevision?: number,
    channelEnvelope?: DevUpdateSignedEnvelope,
  ): void {
    this.assertNotCorrupted();
    const normHash = sha256.toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const envelopeJson = channelEnvelope ? JSON.stringify(channelEnvelope) : null;
    const rev = typeof channelRevision === 'number' && Number.isSafeInteger(channelRevision) ? channelRevision : null;

    try {
      const tx = this.db.transaction(() => {
        // Immutable merge: inspect existing sticky deny record
        const existingStmt = this.db.prepare(
          'SELECT channel_revision, channel_envelope_json FROM sticky_denies WHERE release_id = ? OR sha256 = ?',
        );
        const existingRow = existingStmt.get(releaseId, normHash) as
          | { channel_revision: number | null; channel_envelope_json: string | null }
          | undefined;

        let finalRev = rev;
        let finalEnvelopeJson = envelopeJson;

        if (existingRow) {
          const existingRev = existingRow.channel_revision;
          const existingEnvelopeJson = existingRow.channel_envelope_json;

          if (!finalEnvelopeJson && existingEnvelopeJson) {
            finalEnvelopeJson = existingEnvelopeJson;
          }
          if (existingRev !== null) {
            if (finalRev === null || existingRev > finalRev) {
              finalRev = existingRev;
              if (existingEnvelopeJson) finalEnvelopeJson = existingEnvelopeJson;
            }
          }
        }

        const denyStmt = this.db.prepare(
          `INSERT OR REPLACE INTO sticky_denies (
            release_id, sha256, denied_at, reason, channel_revision, channel_envelope_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        denyStmt.run(releaseId, normHash, nowSec, reason, finalRev, finalEnvelopeJson);

        if (finalRev !== null) {
          this.recordHighestRevision(finalRev);
        }

        this.db.prepare('DELETE FROM ready_candidate WHERE release_id = ? OR file_hash = ?').run(releaseId, normHash);
        this.db.prepare('DELETE FROM allowed_receipts WHERE release_id = ? OR sha256 = ?').run(releaseId, normHash);
      });

      tx();
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  recordAllowedReceipt(receipt: DevUpdateAllowedReceiptRecord): void {
    this.assertNotCorrupted();
    const normHash = receipt.sha256.toLowerCase();
    if (this.isDenied(receipt.releaseId, normHash)) {
      throw new DevUpdateRevokedError(receipt.releaseId, normHash, 'revoked');
    }

    // 1. Cryptographically verify and decode channel envelope
    const channelKey = this.trustedKeys[receipt.channelEnvelope.keyId];
    if (!channelKey) {
      throw new DevUpdateVerificationError('unknown-channel-key-id', `Unknown keyId: ${receipt.channelEnvelope.keyId}`);
    }
    const rawChannelBuf = Buffer.from(receipt.channelEnvelope.payloadBase64, 'base64');
    const rawChannelStr = rawChannelBuf.toString('utf8');
    if (!Buffer.from(rawChannelStr, 'utf8').equals(rawChannelBuf)) {
      throw new DevUpdateVerificationError('invalid-utf8-bytes', 'Channel payload contains invalid UTF-8 bytes');
    }
    const isChannelSigValid = verifyEd25519Signature(
      CHANNEL_SIGN_DOMAIN,
      rawChannelBuf,
      receipt.channelEnvelope.signatureBase64,
      channelKey,
    );
    if (!isChannelSigValid) {
      throw new DevUpdateVerificationError(APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR, 'Channel signature invalid');
    }
    const parsedChannel = parseStrictJsonWithoutDuplicates(rawChannelStr);
    const channelPayload = validateChannelPayload(parsedChannel);

    // 2. Strict verification that candidate is NOT null and status is 'allowed'
    if (!channelPayload.candidate) {
      throw new DevUpdateVerificationError(
        'missing-allowed-candidate',
        'Cannot record allowed receipt: channel payload has null candidate',
      );
    }
    if (
      channelPayload.candidate.releaseId !== receipt.releaseId
      || channelPayload.candidate.sha256.toLowerCase() !== normHash
      || channelPayload.candidate.status !== 'allowed'
    ) {
      throw new DevUpdateVerificationError(
        'candidate-not-allowed',
        `Channel candidate status is not allowed for releaseId=${receipt.releaseId}`,
      );
    }

    // 3. Exact field binding between signed payload and record
    if (channelPayload.nonce !== receipt.requestNonce) {
      throw new DevUpdateVerificationError('nonce-mismatch', 'Signed channel nonce does not match receipt requestNonce');
    }
    if (channelPayload.revision !== receipt.channelRevision) {
      throw new DevUpdateVerificationError('revision-mismatch', 'Signed channel revision does not match receipt revision');
    }
    if (channelPayload.issuedAt !== receipt.channelIssuedAt || channelPayload.expiresAt !== receipt.channelExpiresAt) {
      throw new DevUpdateVerificationError('timing-mismatch', 'Signed channel timestamps do not match receipt timestamps');
    }

    // 4. Validate receipt validity window against the SIGNED channel timestamps
    const issuedAt = channelPayload.issuedAt;
    const expiresAt = channelPayload.expiresAt;
    const verifiedAt = receipt.verifiedAt;
    if (verifiedAt < issuedAt - CLOCK_TOLERANCE_SECONDS || verifiedAt > expiresAt + CLOCK_TOLERANCE_SECONDS) {
      throw new DevUpdateVerificationError(
        'receipt-expired-at-acceptance',
        `Receipt was not valid at acceptance time: verifiedAt=${verifiedAt}, issuedAt=${issuedAt}, expiresAt=${expiresAt}`,
      );
    }

    // 5. Cryptographically verify and decode release envelope
    const releaseKey = this.trustedKeys[receipt.releaseEnvelope.keyId];
    if (!releaseKey) {
      throw new DevUpdateVerificationError('unknown-release-key-id', `Unknown keyId: ${receipt.releaseEnvelope.keyId}`);
    }
    const rawReleaseBuf = Buffer.from(receipt.releaseEnvelope.payloadBase64, 'base64');
    const rawReleaseStr = rawReleaseBuf.toString('utf8');
    if (!Buffer.from(rawReleaseStr, 'utf8').equals(rawReleaseBuf)) {
      throw new DevUpdateVerificationError('invalid-utf8-bytes', 'Release payload contains invalid UTF-8 bytes');
    }
    const isReleaseSigValid = verifyEd25519Signature(
      RELEASE_SIGN_DOMAIN,
      rawReleaseBuf,
      receipt.releaseEnvelope.signatureBase64,
      releaseKey,
    );
    if (!isReleaseSigValid) {
      throw new DevUpdateVerificationError(APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR, 'Release signature invalid');
    }
    const parsedRelease = parseStrictJsonWithoutDuplicates(rawReleaseStr);
    const releasePayload = validateReleasePayload(parsedRelease);
    if (
      releasePayload.releaseId !== receipt.releaseId
      || releasePayload.sha256.toLowerCase() !== normHash
      || releasePayload.version !== receipt.version
    ) {
      throw new DevUpdateVerificationError('release-mismatch', 'Release payload does not match receipt identity');
    }

    try {
      const tx = this.db.transaction(() => {
        this.recordHighestRevision(receipt.channelRevision);
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO allowed_receipts (
            release_id, sha256, version, raw_release_payload,
            release_envelope_json, channel_envelope_json, request_nonce,
            channel_revision, verified_at, channel_issued_at, channel_expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          receipt.releaseId,
          normHash,
          receipt.version,
          receipt.rawReleasePayload,
          JSON.stringify(receipt.releaseEnvelope),
          JSON.stringify(receipt.channelEnvelope),
          receipt.requestNonce,
          receipt.channelRevision,
          receipt.verifiedAt,
          receipt.channelIssuedAt,
          receipt.channelExpiresAt,
        );
      });

      tx();
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  getAllowedReceipt(releaseId: string, sha256: string): DevUpdateAllowedReceiptRecord | null {
    this.assertNotCorrupted();
    const normHash = sha256.toLowerCase();
    if (this.isDenied(releaseId, normHash)) {
      return null;
    }

    try {
      const stmt = this.db.prepare('SELECT * FROM allowed_receipts WHERE release_id = ? AND sha256 = ?');
      const row = stmt.get(releaseId, normHash) as AllowedReceiptRow | undefined;
      if (!row) return null;

      let releaseEnvelope: DevUpdateSignedEnvelope;
      let channelEnvelope: DevUpdateSignedEnvelope;
      try {
        releaseEnvelope = JSON.parse(row.release_envelope_json) as DevUpdateSignedEnvelope;
        channelEnvelope = JSON.parse(row.channel_envelope_json) as DevUpdateSignedEnvelope;
      } catch (parseErr) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Corrupted envelope JSON in allowed_receipts: ${String(parseErr)}`);
      }

      return {
        releaseId: row.release_id,
        sha256: row.sha256,
        version: row.version,
        rawReleasePayload: row.raw_release_payload,
        releaseEnvelope,
        channelEnvelope,
        requestNonce: row.request_nonce,
        channelRevision: row.channel_revision,
        verifiedAt: row.verified_at,
        channelIssuedAt: row.channel_issued_at,
        channelExpiresAt: row.channel_expires_at,
      };
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  saveReadyCandidate(ready: DevUpdateReadyRecord): void {
    this.assertNotCorrupted();
    const releaseId = ready.releasePayload.releaseId;
    const normHash = ready.fileHash.toLowerCase();

    if (this.isDenied(releaseId, normHash)) {
      throw new DevUpdateRevokedError(releaseId, normHash, 'revoked');
    }

    try {
      const tx = this.db.transaction(() => {
        // Save corresponding allowed receipt
        this.recordAllowedReceipt({
          releaseId,
          sha256: normHash,
          version: ready.version,
          rawReleasePayload: Buffer.from(ready.releaseEnvelope.payloadBase64, 'base64').toString('utf8'),
          releaseEnvelope: ready.releaseEnvelope,
          channelEnvelope: ready.channelEnvelope,
          requestNonce: ready.requestNonce,
          channelRevision: ready.channelRevision,
          verifiedAt: ready.verifiedAt,
          channelIssuedAt: ready.channelIssuedAt,
          channelExpiresAt: ready.channelExpiresAt,
        });

        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO ready_candidate (
            id, version, file_path, file_hash, file_size, release_id,
            raw_release_payload, release_envelope_json, channel_envelope_json,
            request_nonce, channel_revision, verified_at, channel_issued_at,
            channel_expires_at, install_attempted
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          ready.version,
          ready.filePath,
          normHash,
          ready.fileSize,
          releaseId,
          Buffer.from(ready.releaseEnvelope.payloadBase64, 'base64').toString('utf8'),
          JSON.stringify(ready.releaseEnvelope),
          JSON.stringify(ready.channelEnvelope),
          ready.requestNonce,
          ready.channelRevision,
          ready.verifiedAt,
          ready.channelIssuedAt,
          ready.channelExpiresAt,
          ready.installAttempted ? 1 : 0,
        );
      });

      tx();
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  getReadyCandidate(): DevUpdateReadyRecord | null {
    this.assertNotCorrupted();
    try {
      const stmt = this.db.prepare('SELECT * FROM ready_candidate WHERE id = 1');
      const row = stmt.get() as ReadyRow | undefined;
      if (!row) return null;

      if (this.isDenied(row.release_id, row.file_hash)) {
        this.clearReadyCandidate();
        return null;
      }

      const releaseEnvelope = JSON.parse(row.release_envelope_json) as DevUpdateSignedEnvelope;
      const channelEnvelope = JSON.parse(row.channel_envelope_json) as DevUpdateSignedEnvelope;
      const rawRelease = Buffer.from(releaseEnvelope.payloadBase64, 'base64').toString('utf8');
      const releasePayload = parseStrictJsonWithoutDuplicates(rawRelease) as DevUpdateReleasePayload;

      return {
        version: row.version,
        filePath: row.file_path,
        fileHash: row.file_hash,
        fileSize: row.file_size,
        releasePayload,
        releaseEnvelope,
        channelEnvelope,
        requestNonce: row.request_nonce,
        channelRevision: row.channel_revision,
        verifiedAt: row.verified_at,
        channelIssuedAt: row.channel_issued_at,
        channelExpiresAt: row.channel_expires_at,
        installAttempted: row.install_attempted === 1,
      };
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  clearReadyCandidate(): void {
    this.assertNotCorrupted();
    try {
      this.db.prepare('DELETE FROM ready_candidate WHERE id = 1').run();
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  markInstallAttempted(): void {
    this.assertNotCorrupted();
    try {
      this.db.prepare('UPDATE ready_candidate SET install_attempted = 1 WHERE id = 1').run();
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }
  }

  /**
   * Synchronous install lock. Throws synchronously before any await if already held.
   */
  acquireInstallLock(): () => void {
    this.assertNotCorrupted();
    if (this.isInstallLocked) {
      throw new Error(APP_UPDATE_DEV_INSTALL_LOCKED_ERROR);
    }
    this.isInstallLocked = true;
    return () => {
      this.isInstallLocked = false;
    };
  }

  /**
   * Synchronous final deny gate. Checked synchronously right before installer invocation.
   */
  assertCanInstall(releaseId: string, sha256: string): void {
    this.assertNotCorrupted();
    const normHash = sha256.toLowerCase();
    if (this.isDenied(releaseId, normHash)) {
      throw new Error(APP_UPDATE_DEV_REVOKED_ERROR);
    }
    const receipt = this.getAllowedReceipt(releaseId, normHash);
    if (!receipt) {
      throw new Error(APP_UPDATE_DEV_UNTRUSTED_ERROR);
    }
  }

  /**
   * Re-verify file size, SHA256 stream hash, and cryptographic signatures of cached ready candidate.
   * Discards and clears candidate if any check fails.
   */
  async restoreReadyCandidate(
    customKeys?: Record<string, string>,
  ): Promise<DevUpdateRestoredReady | null> {
    this.assertNotCorrupted();
    const keys = customKeys ?? this.trustedKeys;
    let row: ReadyRow | undefined;
    try {
      const stmt = this.db.prepare('SELECT * FROM ready_candidate WHERE id = 1');
      row = stmt.get() as ReadyRow | undefined;
    } catch (err) {
      this.isCorruptedLatch = true;
      throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Failed to read ready_candidate: ${String(err)}`);
    }
    if (!row) return null;

    const releaseId = row.release_id;
    const fileHash = row.file_hash.toLowerCase();
    const filePath = row.file_path;

    // 1. Sticky deny check
    if (this.isDenied(releaseId, fileHash)) {
      this.clearReadyCandidate();
      return null;
    }

    // 2. File existence check
    if (!fs.existsSync(filePath)) {
      this.clearReadyCandidate();
      return null;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
      if (!stat.isFile()) {
        this.clearReadyCandidate();
        return null;
      }
    } catch {
      this.clearReadyCandidate();
      return null;
    }

    if (stat.size !== row.file_size) {
      this.clearReadyCandidate();
      return null;
    }

    // 4. File hash check by streaming SHA256
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
    if (!computedHash || computedHash !== fileHash) {
      this.clearReadyCandidate();
      return null;
    }

    // 5. Parse and cryptographically verify cached envelopes
    let releaseEnvelope: DevUpdateSignedEnvelope;
    let channelEnvelope: DevUpdateSignedEnvelope;
    let releasePayload: DevUpdateReleasePayload;
    try {
      try {
        releaseEnvelope = JSON.parse(row.release_envelope_json) as DevUpdateSignedEnvelope;
        channelEnvelope = JSON.parse(row.channel_envelope_json) as DevUpdateSignedEnvelope;
      } catch (parseErr) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Corrupted envelope JSON in ready_candidate: ${String(parseErr)}`);
      }

      const releaseKey = keys[releaseEnvelope.keyId];
      if (!releaseKey) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Missing trusted key for keyId: ${releaseEnvelope.keyId}`);
      }
      const rawRelease = Buffer.from(releaseEnvelope.payloadBase64, 'base64').toString('utf8');
      const validReleaseSig = verifyEd25519Signature(
        RELEASE_SIGN_DOMAIN,
        rawRelease,
        releaseEnvelope.signatureBase64,
        releaseKey,
      );
      if (!validReleaseSig) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Stored release envelope failed cryptographic verification`);
      }

      const channelKey = keys[channelEnvelope.keyId];
      if (!channelKey) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Missing trusted key for keyId: ${channelEnvelope.keyId}`);
      }
      const rawChannel = Buffer.from(channelEnvelope.payloadBase64, 'base64').toString('utf8');
      const validChannelSig = verifyEd25519Signature(
        CHANNEL_SIGN_DOMAIN,
        rawChannel,
        channelEnvelope.signatureBase64,
        channelKey,
      );
      if (!validChannelSig) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Stored channel envelope failed cryptographic verification`);
      }

      const parsedRelease = parseStrictJsonWithoutDuplicates(rawRelease);
      releasePayload = validateReleasePayload(parsedRelease);

      const parsedChannel = parseStrictJsonWithoutDuplicates(rawChannel);
      const channelPayload = validateChannelPayload(parsedChannel);

      // Exact bindings to SIGNED channel payload:
      if (channelPayload.nonce !== row.request_nonce) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Nonce mismatch with signed channel payload`);
      }
      if (channelPayload.revision !== row.channel_revision) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Revision mismatch with signed channel payload`);
      }
      if (
        channelPayload.issuedAt !== row.channel_issued_at
        || channelPayload.expiresAt !== row.channel_expires_at
      ) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Timestamp mismatch with signed channel payload`);
      }

      // Candidate binding check in channel receipt
      if (
        !channelPayload.candidate
        || channelPayload.candidate.releaseId !== releaseId
        || channelPayload.candidate.sha256.toLowerCase() !== fileHash
        || channelPayload.candidate.status !== 'allowed'
      ) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Signed channel does not allow ready candidate`);
      }

      // Release payload consistency check
      if (
        releasePayload.releaseId !== releaseId
        || releasePayload.sha256.toLowerCase() !== fileHash
        || releasePayload.size !== row.file_size
        || releasePayload.version !== row.version
      ) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Release payload consistency check failed`);
      }

      // Acceptance timing check
      if (
        row.verified_at < channelPayload.issuedAt - CLOCK_TOLERANCE_SECONDS
        || row.verified_at > channelPayload.expiresAt + CLOCK_TOLERANCE_SECONDS
      ) {
        this.isCorruptedLatch = true;
        throw new Error(`${APP_UPDATE_DEV_STORE_CORRUPTED_ERROR}: Acceptance timing invalid against signed channel times`);
      }
    } catch (err) {
      this.isCorruptedLatch = true;
      throw err;
    }

    // Final deny check
    if (this.isDenied(releaseId, fileHash)) {
      this.clearReadyCandidate();
      return null;
    }

    const record: DevUpdateReadyRecord = {
      version: row.version,
      filePath: row.file_path,
      fileHash,
      fileSize: row.file_size,
      releasePayload,
      releaseEnvelope,
      channelEnvelope,
      requestNonce: row.request_nonce,
      channelRevision: row.channel_revision,
      verifiedAt: row.verified_at,
      channelIssuedAt: row.channel_issued_at,
      channelExpiresAt: row.channel_expires_at,
      installAttempted: row.install_attempted === 1,
    };

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
        highestRevision: row.channel_revision,
      },
    };

    return { record, info };
  }
}
