import crypto from 'crypto';
import { app, BrowserWindow, session } from 'electron';
import fs from 'fs';
import path from 'path';

import { LogReporterStoreKey } from '../../shared/analytics/constants';
import {
  APP_UPDATE_DEV_INSTALL_LOCKED_ERROR,
  APP_UPDATE_DEV_REVOKED_ERROR,
  APP_UPDATE_DEV_SCOPE_MISMATCH_ERROR,
  APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR,
  APP_UPDATE_DEV_STORE_CORRUPTED_ERROR,
  APP_UPDATE_DEV_UNTRUSTED_ERROR,
  APP_UPDATE_FILE_INVALID_ERROR,
  APP_UPDATE_GRAY_UNAVAILABLE_ERROR,
  APP_UPDATE_URL_UNTRUSTED_ERROR,
  type AppUpdateCheckResult,
  type AppUpdateInfo,
  AppUpdateIpc,
  type AppUpdateRuntimeState,
  AppUpdateSource,
  AppUpdateStatus,
  isManualDownloadUrl,
} from '../../shared/appUpdate/constants';
import type { DevUpdateCheckResult } from '../../shared/appUpdate/devUpdateTypes';
import type { SqliteStore } from '../sqliteStore';
import { AppUpdateGrayClient, canReuseUpdatePackage } from './appUpdateGrayClient';
import {
  cancelActiveDownload,
  downloadUpdate,
  installUpdate,
  MAC_UPDATE_MOUNT_DIR_PREFIX,
} from './appUpdateInstaller';
import {
  AppUpdateUrlUntrustedError,
  assertTrustedWindowsInstallerUrl,
  isSecureWindowsInstallerOrigin,
  validateWindowsInstallerUrl,
  WINDOWS_INSTALLER_URL_POLICY_VERSION,
  type WindowsInstallerUrlPolicyReceipt,
} from './appUpdateUrlPolicy';
import { DevUpdateClient } from './devUpdateClient';
import {
  DevUpdateRevokedError,
  DevUpdateVerificationError,
} from './devUpdateProtocol';
import { DevUpdateTrustStore } from './devUpdateTrustStore';
import {
  getFallbackDownloadUrl,
  getManualUpdateCheckUrl,
  getUpdateCheckUrl,
} from './endpoints';
import { getKeyfromAttribution } from './keyfromAttribution';

type ChangeLogLang = {
  title?: string;
  content?: string[];
};

type PlatformDownload = {
  url?: string;
};

type UpdateApiResponse = {
  code?: number;
  data?: {
    value?: {
      version?: string;
      date?: string;
      changeLog?: {
        ch?: ChangeLogLang;
        en?: ChangeLogLang;
      };
      macIntel?: PlatformDownload;
      macArm?: PlatformDownload;
      windowsX64?: PlatformDownload;
    };
  };
};

function formatUpdateUrlForLog(rawUrl: string): string {
  if (process.platform !== 'win32') {
    return rawUrl;
  }
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

export const INSTALLATION_UUID_KEY = LogReporterStoreKey.InstallationUuid;
const APP_UPDATE_TEST_CURRENT_VERSION_ENV = 'LOBSTERAI_UPDATE_CURRENT_VERSION';
export const APP_UPDATE_READY_FILE_KEY_PREFIX = 'app_update_ready_file';

type StoredReadyFile = {
  version: string;
  filePath: string;
  fileHash: string;
  info?: AppUpdateInfo;
  windowsInstallerUrlPolicyReceipt?: WindowsInstallerUrlPolicyReceipt;
  /** Set when the user launched an install; lets the next startup detect an install that never completed. */
  installAttempted?: boolean;
};

type ReadyWindowsInstallerTrust = {
  version: string;
  filePath: string;
  fileHash: string;
  receipt: WindowsInstallerUrlPolicyReceipt;
};

export interface DevUpdateCoordinatorOptions {
  trustStore: DevUpdateTrustStore;
  client: DevUpdateClient;
}

interface FlowDevCheckResult {
  checkResult: DevUpdateCheckResult;
  verifiedAt: number;
}

const initialState = (): AppUpdateRuntimeState => ({
  status: AppUpdateStatus.Idle,
  source: null,
  info: null,
  progress: null,
  readyFilePath: null,
  readyFileHash: null,
  errorMessage: null,
});

export class AppUpdateCoordinator {
  private state: AppUpdateRuntimeState = initialState();
  private readonly store: SqliteStore;
  private readonly devUpdates?: DevUpdateCoordinatorOptions;
  private readyWindowsInstallerTrust: ReadyWindowsInstallerTrust | null = null;
  private autoOpenReadyModal = false;
  private completedUpdateVersion: string | null = null;
  private flowSequence = 0;
  private activeFlowId = 0;
  private activeFlowSource: AppUpdateSource | null = null;
  private readyRestorePromise: Promise<void> | null = null;

  constructor(
    store: SqliteStore,
    private readonly grayUpdates?: AppUpdateGrayClient,
    devUpdates?: DevUpdateCoordinatorOptions,
  ) {
    this.store = store;
    this.devUpdates = devUpdates;
    this.readyRestorePromise = this.restoreStoredReadyStateAsync();
  }

  getState(): AppUpdateRuntimeState {
    if (this.state.info?.gray && !this.grayUpdates?.isCurrent(this.state.info)
        && this.state.status !== AppUpdateStatus.Installing) {
      if (this.state.status === AppUpdateStatus.Downloading) cancelActiveDownload();
      this.beginFlow(this.state.source ?? AppUpdateSource.Auto, 'gray-session-changed');
      this.resetToIdle();
    }
    return { ...this.state };
  }

  shouldAutoOpenReadyModal(): boolean {
    return this.autoOpenReadyModal;
  }

  consumeAutoOpenReadyModal(): void {
    this.autoOpenReadyModal = false;
  }

  /**
   * Version of an update that finished installing right before this launch
   * (the app is now running that version), or null. Consumed once so the
   * renderer shows its "updated" notice a single time.
   */
  consumeCompletedUpdateVersion(): string | null {
    const version = this.completedUpdateVersion;
    this.completedUpdateVersion = null;
    return version;
  }

  async checkNow(options?: { manual?: boolean; userId?: string | null }): Promise<AppUpdateCheckResult> {
    if (this.readyRestorePromise) {
      await this.readyRestorePromise.catch(() => {});
    }
    this.getState(); // Discard a previous account's gray flow before considering an active download.
    const targetSource = options?.manual === true ? AppUpdateSource.Manual : AppUpdateSource.Auto;
    console.log(
      `[AppUpdate] checkNow started, manual=${options?.manual === true}, status=${this.state.status}, source=${this.state.source ?? 'none'}, readyFilePath=${this.state.readyFilePath ?? 'none'}`,
    );
    if (this.isUpdateDisabled()) {
      console.log('[AppUpdate] updates are disabled by enterprise config');
      if (this.devUpdates) {
        this.devUpdates.trustStore.clearReadyCandidate();
        if (this.state.readyFilePath) {
          void this.cleanupReadyFile(this.state.readyFilePath);
        }
        this.clearStoredReadyFile(AppUpdateSource.Auto);
        this.clearStoredReadyFile(AppUpdateSource.Manual);
      }
      const state = this.resetToIdle();
      return { success: true, state, updateFound: false };
    }

    if (options?.manual === true && this.state.source === AppUpdateSource.Auto) {
      if (this.state.status === AppUpdateStatus.Downloading) {
        console.log('[AppUpdate] manual check is preempting active auto download');
        const cancelled = cancelActiveDownload();
        console.log(`[AppUpdate] auto download cancel requested by manual check, cancelled=${cancelled}`);
      } else if (this.state.status === AppUpdateStatus.Checking) {
        console.log('[AppUpdate] manual check is preempting active auto check before download');
      } else if (this.state.status === AppUpdateStatus.Installing) {
        console.log('[AppUpdate] manual check cannot preempt auto install already in progress');
        return { success: true, state: this.getState(), updateFound: this.state.info !== null };
      }
    }

    if (
      (this.state.status === AppUpdateStatus.Downloading || this.state.status === AppUpdateStatus.Installing) &&
      this.state.source === targetSource
    ) {
      console.log(`[AppUpdate] returning existing active ${targetSource} flow without starting a new check`);
      return { success: true, state: this.getState(), updateFound: this.state.info !== null };
    }

    const previousState = this.getState();
    const flowId = this.beginFlow(
      targetSource,
      options?.manual === true ? 'manual-check' : 'auto-check',
    );
    this.setState({
      ...this.state,
      status: AppUpdateStatus.Checking,
      source: targetSource,
      errorMessage: null,
    });

    try {
      const currentVersion = this.resolveCurrentVersion();
      let flowDevCheck: FlowDevCheckResult | null = null;
      let info: AppUpdateInfo | null = null;
      if (this.devUpdates) {
        const devFetch = await this.fetchDevUpdateInfo(currentVersion);
        info = devFetch.info;
        flowDevCheck = devFetch.devCheck;
      } else {
        info = await this.fetchUpdateInfo(currentVersion, options?.manual === true, options?.userId);
      }
      if (!this.isFlowActive(flowId, targetSource)) {
        console.log(
          `[AppUpdate] ignoring stale check result after fetch, flowId=${flowId}, source=${targetSource}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
        );
        return { success: true, state: this.getState(), updateFound: this.getState().info !== null };
      }
      if (!info) {
        if (this.devUpdates && previousState.info?.dev) {
          const cand = this.devUpdates.trustStore.getReadyCandidate();
          if (!cand || this.devUpdates.trustStore.isDenied(previousState.info.dev.releaseId, previousState.info.dev.sha256)) {
            const didClear = await this.safeClearOwnedReady({
              filePath: previousState.readyFilePath,
              fileHash: previousState.readyFileHash,
              source: targetSource,
              releaseId: previousState.info.dev.releaseId,
            });
            if (!didClear || !this.isFlowActive(flowId, targetSource) || this.state !== previousState) {
              return { success: true, state: this.getState(), updateFound: this.getState().info !== null };
            }
          }
        }
        if (
          previousState.source === targetSource &&
          previousState.status === AppUpdateStatus.Ready &&
          previousState.readyFilePath != null &&
          previousState.readyFileHash != null &&
          previousState.info != null &&
          !previousState.info.gray &&
          (!previousState.info.dev || (this.devUpdates && !this.devUpdates.trustStore.isDenied(previousState.info.dev.releaseId, previousState.info.dev.sha256))) &&
          this.compareVersions(previousState.info.latestVersion, currentVersion) > 0
        ) {
          console.log(
            `[AppUpdate] no update from server, preserving existing ready update ${previousState.info.latestVersion}`,
          );
          const state = this.setState({
            ...previousState,
            errorMessage: null,
          });
          return { success: true, state, updateFound: true };
        }
        const state = this.setState({
          ...initialState(),
          source: targetSource,
        });
        return { success: true, state, updateFound: false };
      }

      const updateFound = true;
      const matchingReadyFile = await this.resolveMatchingReadyFile(
        previousState,
        targetSource,
        info,
      );
      if (!this.isFlowActive(flowId, targetSource)) {
        console.log(
          `[AppUpdate] ignoring stale check result after ready-file resolution, flowId=${flowId}, source=${targetSource}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
        );
        return { success: true, state: this.getState(), updateFound: this.getState().info !== null };
      }

      if (matchingReadyFile) {
        if (info.gray && !this.grayUpdates?.isCurrent(info)) {
          return { success: true, state: this.resetToIdle(), updateFound: false };
        }
        console.log(
          `[AppUpdate] reusing ready file for version ${info.latestVersion}: ${matchingReadyFile.filePath}`,
        );
        this.bindReadyWindowsInstallerTrust(matchingReadyFile);
        const state = this.setState({
          ...previousState,
          info,
          status: AppUpdateStatus.Ready,
          source: targetSource,
          readyFilePath: matchingReadyFile.filePath,
          readyFileHash: matchingReadyFile.fileHash,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      console.log(
        `[AppUpdate] no reusable ready file found for version ${info.latestVersion}, previousReadyFilePath=${previousState.readyFilePath ?? 'none'}`,
      );
      const existingReadyFile = this.getStoredReadyFile(targetSource);
      if (existingReadyFile?.filePath) {
        await this.cleanupReadyFile(existingReadyFile.filePath);
      }
      this.clearStoredReadyFile(targetSource);
      await this.pruneCachedInstallerFiles(targetSource, [], () => this.isFlowActive(flowId, targetSource));

      if (info.gray && (!this.isFlowActive(flowId, targetSource) || !this.grayUpdates?.isCurrent(info))) {
        const state = this.isFlowActive(flowId, targetSource) ? this.resetToIdle() : this.getState();
        return { success: true, state, updateFound: state.info !== null };
      }

      if (!this.canPredownload(info.url, info)) {
        const state = this.setState({
          status: AppUpdateStatus.Available,
          source: targetSource,
          info,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      if (options?.manual === true) {
        const state = this.setState({
          status: AppUpdateStatus.Available,
          source: targetSource,
          info,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      const state = await this.startDownload(info, flowId, targetSource, flowDevCheck);
      return { success: true, state, updateFound: info.gray ? state.info !== null : updateFound };
    } catch (error) {
      if (!this.isFlowActive(flowId, targetSource)) {
        console.log(
          `[AppUpdate] ignoring stale check failure, flowId=${flowId}, source=${targetSource}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
        );
        return { success: true, state: this.getState(), updateFound: this.getState().info !== null };
      }
      console.error('[AppUpdate] check failed:', error);
      const message = error instanceof Error ? error.message : 'Check failed';
      // A failed availability check must not invalidate an already downloaded
      // and verified installer. Demoting Ready to Error here used to strand
      // the update: installReadyUpdate rejects non-Ready states, so every
      // retry failed instantly until the next successful check (e.g. the
      // resume-time check that fails with ERR_NETWORK_IO_SUSPENDED).
      if (previousState.info?.gray) {
        return { success: false, state: this.resetToIdle(), updateFound: false, error: message };
      }
      if (this.devUpdates || previousState.info?.dev) {
        const isTrustOrRevokeError =
          error instanceof DevUpdateRevokedError
          || error instanceof DevUpdateVerificationError
          || (error instanceof Error && (
            error.message.includes(APP_UPDATE_DEV_REVOKED_ERROR)
            || error.message.includes(APP_UPDATE_DEV_UNTRUSTED_ERROR)
            || error.message.includes(APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR)
            || error.message.includes(APP_UPDATE_DEV_SCOPE_MISMATCH_ERROR)
            || error.message.includes(APP_UPDATE_DEV_STORE_CORRUPTED_ERROR)
          ));

        if (
          isTrustOrRevokeError
          || (this.devUpdates && previousState.info?.dev && this.devUpdates.trustStore.isDenied(previousState.info.dev.releaseId, previousState.info.dev.sha256))
        ) {
          const didClear = await this.safeClearOwnedReady({
            filePath: previousState.readyFilePath,
            fileHash: previousState.readyFileHash,
            source: targetSource,
            releaseId: previousState.info?.dev?.releaseId,
          });
          if (!didClear || !this.isFlowActive(flowId, targetSource) || this.state !== previousState) {
            return { success: false, state: this.getState(), updateFound: this.getState().info !== null, error: message };
          }
          const state = this.setState({
            ...initialState(),
            status: AppUpdateStatus.Error,
            source: targetSource,
            errorMessage: message,
          });
          return { success: false, state, updateFound: false, error: message };
        }

        const keepReady =
          previousState.status === AppUpdateStatus.Ready
          && previousState.readyFilePath != null
          && previousState.readyFileHash != null
          && previousState.info?.dev != null
          && this.devUpdates != null
          && !this.devUpdates.trustStore.isDenied(previousState.info.dev.releaseId, previousState.info.dev.sha256)
          && (await this.isReadyFileValid(previousState.readyFilePath, previousState.readyFileHash));

        if (!this.isFlowActive(flowId, targetSource) || this.state !== previousState) {
          return {
            success: false,
            state: this.getState(),
            updateFound: this.getState().info !== null,
            error: message,
          };
        }

        const state = this.setState({
          ...previousState,
          status: keepReady
            ? AppUpdateStatus.Ready
            : previousState.info
              ? AppUpdateStatus.Error
              : AppUpdateStatus.Idle,
          errorMessage: keepReady ? null : message,
        });
        return {
          success: false,
          state,
          updateFound: previousState.info !== null,
          error: message,
        };
      }
      const keepReady =
        previousState.status === AppUpdateStatus.Ready
        && previousState.readyFilePath != null
        && previousState.readyFileHash != null;
      if (keepReady) {
        console.warn(
          `[AppUpdate] check failed but a verified ready update exists, keeping Ready state for version ${previousState.info?.latestVersion ?? 'unknown'}`,
        );
      }
      const state = this.setState({
        ...previousState,
        status: keepReady
          ? AppUpdateStatus.Ready
          : previousState.info
            ? AppUpdateStatus.Error
            : AppUpdateStatus.Idle,
        errorMessage: keepReady ? null : message,
      });
      return {
        success: false,
        state,
        updateFound: previousState.info !== null,
        error: message,
      };
    }
  }

  async retryDownload(): Promise<AppUpdateRuntimeState> {
    this.getState();
    if (!this.state.info) {
      return this.getState();
    }
    if (!this.canPredownload(this.state.info.url, this.state.info)) {
      return this.getState();
    }
    if (this.state.status === AppUpdateStatus.Downloading || this.state.status === AppUpdateStatus.Installing) {
      return this.getState();
    }
    const source = this.state.source ?? AppUpdateSource.Auto;
    const flowId = this.beginFlow(source, 'retry-download');
    const info = this.state.info;
    if (info.dev && this.devUpdates) {
      if (this.devUpdates.trustStore.isDenied(info.dev.releaseId, info.dev.sha256)) {
        return this.resetToIdle();
      }
    }
    let flowDevCheck: FlowDevCheckResult | null = null;
    if (info.dev && this.devUpdates) {
      const currentVersion = this.resolveCurrentVersion();
      const expectedReleaseId = info.dev.releaseId;
      const expectedSha256 = info.dev.sha256.toLowerCase();
      // Retry check exact requested candidate+matching release info no nullproof
      const checkResult = await this.devUpdates.client.checkForUpdate(currentVersion, {
        releaseId: expectedReleaseId,
        sha256: expectedSha256,
      });

      if (!this.isFlowActive(flowId, source)) return this.getState();

      if (
        !checkResult.channelEnvelope
        || this.devUpdates.trustStore.isDenied(expectedReleaseId, expectedSha256)
      ) {
        console.warn('[AppUpdate] retry rejected: requested candidate is denied or missing channel envelope');
        return this.resetToIdle();
      }

      // Fetch bound latestB reject if expectedA:
      if (
        !checkResult.releasePayload
        || checkResult.releasePayload.releaseId !== expectedReleaseId
        || checkResult.releasePayload.sha256.toLowerCase() !== expectedSha256
      ) {
        console.warn('[AppUpdate] retry rejected: server release payload does not match expected candidate');
        return this.resetToIdle();
      }

      const verifiedAt = Math.floor(Date.now() / 1000);
      this.devUpdates.trustStore.recordAllowedReceipt({
        releaseId: expectedReleaseId,
        sha256: expectedSha256,
        version: checkResult.releasePayload.version,
        rawReleasePayload: Buffer.from(checkResult.releaseEnvelope!.payloadBase64, 'base64').toString('utf8'),
        releaseEnvelope: checkResult.releaseEnvelope!,
        channelEnvelope: checkResult.channelEnvelope!,
        requestNonce: checkResult.requestNonce,
        channelRevision: checkResult.channelRevision,
        verifiedAt,
        channelIssuedAt: checkResult.channelIssuedAt,
        channelExpiresAt: checkResult.channelExpiresAt,
      });
      flowDevCheck = { checkResult, verifiedAt };
    }
    if (info.gray) {
      const allowed = await this.grayUpdates?.authorize(info, this.resolveCurrentVersion(), source);
      if (!this.isFlowActive(flowId, source)) return this.getState();
      if (!allowed) return this.resetToIdle();
    }
    void this.startDownload(info, flowId, source, flowDevCheck);
    return this.getState();
  }

  async installReadyUpdate(): Promise<{
    success: boolean;
    state: AppUpdateRuntimeState;
    error?: string;
  }> {
    // Synchronous install lock before first await
    let releaseInstallLock: (() => void) | null = null;
    if (this.devUpdates) {
      try {
        releaseInstallLock = this.devUpdates.trustStore.acquireInstallLock();
      } catch {
        return {
          success: false,
          state: this.getState(),
          error: APP_UPDATE_DEV_INSTALL_LOCKED_ERROR,
        };
      }
    }

    if (this.readyRestorePromise) {
      await this.readyRestorePromise.catch(() => {});
    }
    this.getState();
    try {
    const checkedState = this.state;
    const initialStatus = checkedState.status;
    const filePath = checkedState.readyFilePath;
    const readyFileHash = checkedState.readyFileHash;
    const readyInfo = checkedState.info;
    const source = checkedState.source;
    // Error with a verified ready file stays installable (defense in depth
    // for any path that lands there): the hash and the Windows URL-policy
    // receipt are re-validated below before the installer launches. Other
    // non-Ready states stay rejected so e.g. a second click during
    // Installing cannot double-launch the installer.
    const installableFromError =
      initialStatus === AppUpdateStatus.Error && readyFileHash != null;
    if (
      !filePath
      || (initialStatus !== AppUpdateStatus.Ready && !installableFromError)
    ) {
      console.warn(
        `[AppUpdate] install rejected: status=${this.state.status}, readyFilePath=${this.state.readyFilePath ?? 'none'}, readyFileHash=${this.state.readyFileHash != null ? 'present' : 'none'}`,
      );
      return {
        success: false,
        state: this.getState(),
        error: 'Update is not ready to install',
      };
    }

    if (readyInfo?.gray) {
      const allowed = await this.grayUpdates?.authorize(
        readyInfo, this.resolveCurrentVersion(), this.state.source ?? AppUpdateSource.Auto,
      );
      if (this.state !== checkedState) {
        return { success: false, state: this.getState(), error: APP_UPDATE_GRAY_UNAVAILABLE_ERROR };
      }
      if (!allowed) {
        return { success: false, state: this.resetToIdle(), error: APP_UPDATE_GRAY_UNAVAILABLE_ERROR };
      }
    }

    // Dev pre-install verification: <=10s online check with exact typed offline fallback
    if (readyInfo?.dev && this.devUpdates) {
      try {
        const { offlineFallback } = await this.devUpdates.client.preInstallVerification({
          releaseId: readyInfo.dev.releaseId,
          sha256: readyInfo.dev.sha256,
          currentVersion: this.resolveCurrentVersion(),
          filePath,
          expectedSize: readyInfo.dev.size,
        });
        console.log(`[AppUpdate] Dev pre-install verification passed, offlineFallback=${offlineFallback}`);
      } catch (verifyError) {
        console.error('[AppUpdate] Dev pre-install verification failed:', verifyError);

        if (
          this.state !== checkedState
          || this.state.readyFilePath !== filePath
          || this.state.readyFileHash !== readyFileHash
        ) {
          return { success: false, state: this.getState(), error: 'State changed concurrently during verification' };
        }

        const isRevoked =
          verifyError instanceof DevUpdateRevokedError
          || (verifyError instanceof Error && verifyError.message.includes(APP_UPDATE_DEV_REVOKED_ERROR));

        const didClear = await this.safeClearOwnedReady({
          filePath,
          fileHash: readyFileHash,
          source,
          releaseId: readyInfo.dev.releaseId,
        });
        if (!didClear || this.state !== checkedState || this.state.readyFilePath !== filePath || this.state.readyFileHash !== readyFileHash) {
          return { success: false, state: this.getState(), error: 'State changed concurrently during verification' };
        }

        const errorToken = isRevoked
          ? APP_UPDATE_DEV_REVOKED_ERROR
          : verifyError instanceof Error
            ? verifyError.message
            : APP_UPDATE_DEV_UNTRUSTED_ERROR;

        const state = this.setState({
          status: AppUpdateStatus.Error,
          source,
          info: null,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: errorToken,
        });
        return { success: false, state, error: errorToken };
      }
    }

    if (this.state !== checkedState) {
      return { success: false, state: this.getState(), error: 'Install state changed concurrently' };
    }

    if (!readyInfo?.dev) {
      const readyReceipt = this.getReadyWindowsInstallerReceipt({
        version: readyInfo?.latestVersion ?? '',
        filePath,
        fileHash: readyFileHash ?? '',
        source: this.state.source,
      });
      if (!this.isTrustedWindowsReadyInstallerInfo(readyInfo ?? undefined, readyReceipt)) {
        await this.cleanupReadyFile(filePath);
        if (
          this.state !== checkedState
          || this.state.readyFilePath !== filePath
          || this.state.readyFileHash !== readyFileHash
        ) {
          return { success: false, state: this.getState(), error: APP_UPDATE_URL_UNTRUSTED_ERROR };
        }
        if (readyInfo?.gray && this.state !== checkedState) {
          return { success: false, state: this.getState(), error: APP_UPDATE_GRAY_UNAVAILABLE_ERROR };
        }
        this.clearStoredReadyFile(source);
        this.readyWindowsInstallerTrust = null;
        const state = this.setState({
          status: AppUpdateStatus.Error,
          source,
          info: null,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: APP_UPDATE_URL_UNTRUSTED_ERROR,
        });
        return {
          success: false,
          state,
          error: APP_UPDATE_URL_UNTRUSTED_ERROR,
        };
      }
    }
    const validFile = readyFileHash != null && await this.isReadyFileValid(filePath, readyFileHash);
    if (this.state !== checkedState || this.state.readyFilePath !== filePath || this.state.readyFileHash !== readyFileHash) {
      return { success: false, state: this.getState(), error: 'Install state changed concurrently' };
    }
    if (readyInfo?.gray && !this.grayUpdates?.isCurrent(readyInfo)) {
      return { success: false, state: this.getState(), error: APP_UPDATE_GRAY_UNAVAILABLE_ERROR };
    }
    if (!validFile) {
      if (
        this.state !== checkedState
        || this.state.readyFilePath !== filePath
        || this.state.readyFileHash !== readyFileHash
      ) {
        return { success: false, state: this.getState(), error: APP_UPDATE_FILE_INVALID_ERROR };
      }
      const didClear = await this.safeClearOwnedReady({
        filePath,
        fileHash: readyFileHash,
        source,
        releaseId: readyInfo?.dev?.releaseId,
      });
      if (!didClear || this.state !== checkedState || this.state.readyFilePath !== filePath || this.state.readyFileHash !== readyFileHash) {
        return { success: false, state: this.getState(), error: APP_UPDATE_FILE_INVALID_ERROR };
      }
      this.readyWindowsInstallerTrust = null;
      const message = APP_UPDATE_FILE_INVALID_ERROR;
      const state = this.setState({
        status: AppUpdateStatus.Available,
        source,
        info: readyInfo,
        progress: null,
        readyFilePath: null,
        readyFileHash: null,
        errorMessage: message,
      });
      return {
        success: false,
        state,
        error: message,
      };
    }

    // Final checkedState / flow / snapshot / candidate identity gate right before installer invocation
    if (this.state !== checkedState) {
      return { success: false, state: this.getState(), error: 'Install state changed concurrently' };
    }

    if (readyInfo?.dev && this.devUpdates) {
      const currentReadyRecord = this.devUpdates.trustStore.getReadyCandidate();
      const isCandidateDenied = this.devUpdates.trustStore.isDenied(readyInfo.dev.releaseId, readyInfo.dev.sha256);
      const isCandidateMatched =
        currentReadyRecord != null
        && currentReadyRecord.releasePayload.releaseId === readyInfo.dev.releaseId
        && currentReadyRecord.fileHash.toLowerCase() === readyInfo.dev.sha256.toLowerCase()
        && this.state.readyFilePath === filePath
        && this.state.readyFileHash?.toLowerCase() === readyInfo.dev.sha256.toLowerCase()
        && this.state.info?.dev?.releaseId === readyInfo.dev.releaseId
        && this.state.info?.dev?.sha256 === readyInfo.dev.sha256;

      if (!isCandidateMatched || isCandidateDenied) {
        console.warn('[AppUpdate] final candidate check failed right before installer launch');
        const didClear = await this.safeClearOwnedReady({
          filePath,
          fileHash: readyFileHash,
          source,
          releaseId: readyInfo.dev.releaseId,
        });
        if (!didClear || this.state !== checkedState || this.state.readyFilePath !== filePath || this.state.readyFileHash !== readyFileHash) {
          return { success: false, state: this.getState(), error: APP_UPDATE_DEV_REVOKED_ERROR };
        }
        const errToken = APP_UPDATE_DEV_REVOKED_ERROR;
        const state = this.setState({
          status: AppUpdateStatus.Error,
          source,
          info: null,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: errToken,
        });
        return { success: false, state, error: errToken };
      }

      const allowedReceipt = this.devUpdates.trustStore.getAllowedReceipt(
        readyInfo.dev.releaseId,
        readyInfo.dev.sha256,
      );
      if (
        !allowedReceipt
        || !Number.isSafeInteger(allowedReceipt.verifiedAt)
        || allowedReceipt.verifiedAt <= 0
      ) {
        console.warn('[AppUpdate] final receipt time check failed right before installer launch');
        const didClear = await this.safeClearOwnedReady({
          filePath,
          fileHash: readyFileHash,
          source,
          releaseId: readyInfo.dev.releaseId,
        });
        if (!didClear || this.state !== checkedState || this.state.readyFilePath !== filePath || this.state.readyFileHash !== readyFileHash) {
          return { success: false, state: this.getState(), error: APP_UPDATE_DEV_UNTRUSTED_ERROR };
        }
        const errToken = APP_UPDATE_DEV_UNTRUSTED_ERROR;
        const state = this.setState({
          status: AppUpdateStatus.Error,
          source,
          info: null,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: errToken,
        });
        return { success: false, state, error: errToken };
      }

      try {
        this.devUpdates.trustStore.assertCanInstall(readyInfo.dev.releaseId, readyInfo.dev.sha256);
        this.devUpdates.trustStore.markInstallAttempted();
      } catch {
        const didClear = await this.safeClearOwnedReady({
          filePath,
          fileHash: readyFileHash,
          source,
          releaseId: readyInfo.dev.releaseId,
        });
        if (!didClear || this.state !== checkedState || this.state.readyFilePath !== filePath || this.state.readyFileHash !== readyFileHash) {
          return { success: false, state: this.getState(), error: APP_UPDATE_DEV_REVOKED_ERROR };
        }
        const errToken = APP_UPDATE_DEV_REVOKED_ERROR;
        const state = this.setState({
          status: AppUpdateStatus.Error,
          source,
          info: null,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: errToken,
        });
        return { success: false, state, error: errToken };
      }
    }

    this.setState({
      ...this.state,
      status: AppUpdateStatus.Installing,
      errorMessage: null,
    });

    if (readyInfo && readyFileHash && !readyInfo.dev) {
      const readyReceipt = this.getReadyWindowsInstallerReceipt({
        version: readyInfo.latestVersion,
        filePath,
        fileHash: readyFileHash,
        source: this.state.source,
      });
      this.setStoredReadyFile({
        version: readyInfo.latestVersion,
        filePath,
        fileHash: readyFileHash,
        info: readyInfo,
        windowsInstallerUrlPolicyReceipt: readyReceipt,
        installAttempted: true,
      });
    }

    try {
      await installUpdate(filePath, {
        noDefenderExclusion: this.isDefenderExclusionDisabled(),
      });
      return { success: true, state: this.getState() };
    } catch (error) {
      console.error('[AppUpdate] install failed:', error);
      const message = error instanceof Error ? error.message : 'Installation failed';

      const fileIntact =
        readyFileHash != null
        && (await this.isReadyFileValid(filePath, readyFileHash));
      const isDenied = Boolean(
        readyInfo?.dev && this.devUpdates?.trustStore.isDenied(readyInfo.dev.releaseId, readyInfo.dev.sha256),
      );
      const isSameCandidate = this.canMutateCapturedCandidate({
        filePath,
        fileHash: readyFileHash,
        releaseId: readyInfo?.dev?.releaseId,
      });

      if (fileIntact && isSameCandidate && !isDenied && this.state.status === AppUpdateStatus.Installing) {
        const state = this.setState({
          ...this.state,
          status: AppUpdateStatus.Ready,
          errorMessage: message,
        });
        return { success: false, state, error: message };
      }

      console.warn(`[AppUpdate] ready file is no longer valid after failed install: ${filePath}`);
      const didClear = await this.safeClearOwnedReady({
        filePath,
        fileHash: readyFileHash,
        source: this.state.source,
        releaseId: readyInfo?.dev?.releaseId,
      });
      if (!didClear || this.state.status !== AppUpdateStatus.Installing) {
        return { success: false, state: this.getState(), error: message };
      }
      const state = this.setState({
        ...this.state,
        status: AppUpdateStatus.Available,
        progress: null,
        readyFilePath: null,
        readyFileHash: null,
        errorMessage: message,
      });
      return { success: false, state, error: message };
    }
    } finally {
      if (releaseInstallLock) {
        releaseInstallLock();
      }
    }
  }

  private resetToIdle(): AppUpdateRuntimeState {
    const previousReadyFilePath = this.state.readyFilePath;
    const previousSource = this.state.source;
    const state = this.setState(initialState());
    if (previousReadyFilePath) {
      void this.cleanupReadyFile(previousReadyFilePath);
    }
    this.clearStoredReadyFile(previousSource);
    this.readyWindowsInstallerTrust = null;
    if (this.devUpdates) {
      this.devUpdates.trustStore.clearReadyCandidate();
    }
    return state;
  }
  private async startDownload(
    info: AppUpdateInfo,
    flowId: number,
    source: AppUpdateSource,
    flowDevCheck?: FlowDevCheckResult | null,
  ): Promise<AppUpdateRuntimeState> {
    if (info.gray && !this.grayUpdates?.isCurrent(info)) return this.resetToIdle();
    console.log(
      `[AppUpdate] startDownload requested, flowId=${flowId}, source=${source}, version=${info.latestVersion}, url=${formatUpdateUrlForLog(info.url)}`,
    );
    this.setState({
      status: AppUpdateStatus.Downloading,
      source,
      info,
      progress: null,
      readyFilePath: null,
      readyFileHash: null,
      errorMessage: null,
    });
    this.readyWindowsInstallerTrust = null;

    try {
      const download = await downloadUpdate(
        info.url,
        source,
        progress => {
          if (info.gray && !this.grayUpdates?.isCurrent(info)) {
            this.getState();
            return;
          }
          if (!this.isFlowActive(flowId, source)) {
            console.log(
              `[AppUpdate] ignoring stale download progress, flowId=${flowId}, source=${source}, activeFlowId=${this.activeFlowId}, activeSource=${this.activeFlowSource ?? 'none'}`,
            );
            return;
          }
          this.setState({
            ...this.state,
            status: AppUpdateStatus.Downloading,
            source,
            info,
            progress,
            errorMessage: null,
          });
        },
        info.dev ? { expectedSize: info.dev.size, expectedSha256: info.dev.sha256 } : undefined,
      );
      const filePath = download.filePath;
      if (info.gray && !this.grayUpdates?.isCurrent(info)) {
        await this.cleanupReadyFile(filePath);
        return this.getState();
      }
      if (!this.isFlowActive(flowId, source)) {
        console.log(
          `[AppUpdate] ignoring stale download completion, flowId=${flowId}, source=${source}, filePath=${filePath}`,
        );
        return this.getState();
      }

      const fileHash = await this.computeFileHash(filePath);
      if (info.dev && this.devUpdates) {
        const isFileIntact = await this.devUpdates.client.verifyDownloadedFile(filePath, {
          size: info.dev.size,
          sha256: info.dev.sha256,
        });
        if (!isFileIntact) {
          await this.cleanupReadyFile(filePath);
          throw new Error(APP_UPDATE_FILE_INVALID_ERROR);
        }

        // Synchronous flowgate immediately after validate await BEFORE persistence and before prune!
        if (!this.isFlowActive(flowId, source)) {
          console.log(`[AppUpdate] flow is no longer active after validate await, flowId=${flowId}`);
          await this.cleanupReadyFile(filePath);
          return this.getState();
        }

        if (this.devUpdates.trustStore.isDenied(info.dev.releaseId, info.dev.sha256)) {
          console.warn('[AppUpdate] release was denied during download');
          await this.cleanupReadyFile(filePath);
          return this.resetToIdle();
        }

        if (flowDevCheck && flowDevCheck.checkResult.releasePayload) {
          await this.devUpdates.client.acceptDownloadedReady({
            filePath,
            fileSize: info.dev.size,
            fileHash: info.dev.sha256,
            release: flowDevCheck.checkResult.releasePayload,
            releaseEnvelope: flowDevCheck.checkResult.releaseEnvelope!,
            channelEnvelope: flowDevCheck.checkResult.channelEnvelope!,
            requestNonce: flowDevCheck.checkResult.requestNonce,
            channelRevision: flowDevCheck.checkResult.channelRevision,
            verifiedAt: flowDevCheck.verifiedAt,
            channelIssuedAt: flowDevCheck.checkResult.channelIssuedAt,
            channelExpiresAt: flowDevCheck.checkResult.channelExpiresAt,
          });
        }
      }

      // Synchronous flowgate immediately after accept
      if (!this.isFlowActive(flowId, source)) {
        console.log(`[AppUpdate] flow preempted after accept, flowId=${flowId}`);
        if (filePath !== this.state.readyFilePath) {
          await this.cleanupReadyFile(filePath);
        }
        return this.getState();
      }
      if (info.gray) {
        const allowed = await this.grayUpdates?.authorize(info, this.resolveCurrentVersion(), source);
        if (!this.isFlowActive(flowId, source)) return this.getState();
        if (!allowed) {
          await this.cleanupReadyFile(filePath);
          return this.isFlowActive(flowId, source) ? this.resetToIdle() : this.getState();
        }
      }

      // Synchronous flowgate before prune
      if (!this.isFlowActive(flowId, source)) {
        console.log(`[AppUpdate] flow preempted before prune, flowId=${flowId}`);
        if (filePath !== this.state.readyFilePath) {
          await this.cleanupReadyFile(filePath);
        }
        return this.getState();
      }

      await this.pruneCachedInstallerFiles(source, [filePath], () => this.isFlowActive(flowId, source));

      // Recheck flow after prune
      if (!this.isFlowActive(flowId, source)) {
        console.log(`[AppUpdate] flow preempted during prune, flowId=${flowId}`);
        if (filePath !== this.state.readyFilePath) {
          await this.cleanupReadyFile(filePath);
        }
        return this.getState();
      }

      if (info.dev && this.devUpdates && this.devUpdates.trustStore.isDenied(info.dev.releaseId, info.dev.sha256)) {
        console.warn('[AppUpdate] download completed but release was denied during download');
        const didClear = await this.safeClearOwnedReady({
          filePath,
          fileHash,
          source,
          releaseId: info.dev.releaseId,
        });
        if (!didClear || !this.isFlowActive(flowId, source)) {
          return this.getState();
        }
        return this.resetToIdle();
      }

      console.log(
        `[AppUpdate] download completed, flowId=${flowId}, source=${source}, version=${info.latestVersion}, filePath=${filePath}, fileHash=${fileHash}`,
      );
      const storedReadyFile: StoredReadyFile = {
        version: info.latestVersion,
        filePath,
        fileHash,
        info,
        windowsInstallerUrlPolicyReceipt: info.dev
          ? {
              policyVersion: WINDOWS_INSTALLER_URL_POLICY_VERSION,
              inputOrigin: new URL(info.url).origin,
              finalOrigin: new URL(info.url).origin,
            }
          : download.windowsInstallerUrlPolicyReceipt,
      };
      this.setStoredReadyFile(storedReadyFile);
      if (!info.dev) {
        this.bindReadyWindowsInstallerTrust(storedReadyFile);
      }
      if (info.gray && (!this.isFlowActive(flowId, source) || !this.grayUpdates?.isCurrent(info))) {
        return this.getState();
      }
      this.autoOpenReadyModal = true;
      return this.setState({
        status: AppUpdateStatus.Ready,
        source,
        info,
        progress: null,
        readyFilePath: filePath,
        readyFileHash: fileHash,
        errorMessage: null,
      });
    } catch (error) {
      if (!this.isFlowActive(flowId, source)) {
        console.log(
          `[AppUpdate] ignoring stale download failure, flowId=${flowId}, source=${source}, error=${error instanceof Error ? error.message : String(error)}`,
        );
        return this.getState();
      }
      const cancelled = error instanceof Error && error.message === 'Download cancelled';
      if (cancelled) {
        console.log(`[AppUpdate] download cancelled for active flow, flowId=${flowId}, source=${source}`);
        this.clearStoredReadyFile(source);
        return this.setState({
          status: AppUpdateStatus.Available,
          source,
          info,
          progress: null,
          readyFilePath: null,
          readyFileHash: null,
          errorMessage: null,
        });
      }

      console.error('[AppUpdate] background download failed:', error);
      this.clearStoredReadyFile(source);
      return this.setState({
        status: AppUpdateStatus.Error,
        source,
        info,
        progress: null,
        readyFilePath: null,
        readyFileHash: null,
        errorMessage: error instanceof Error ? error.message : 'Download failed',
      });
    }
  }

  private async fetchUpdateInfo(
    currentVersion: string,
    manual: boolean,
    userId?: string | null,
  ): Promise<AppUpdateInfo | null> {
    if (this.devUpdates) {
      return (await this.fetchDevUpdateInfo(currentVersion)).info;
    }
    const loadStable = () => this.fetchStableUpdateInfo(currentVersion, manual, userId);
    return this.grayUpdates
      ? this.grayUpdates.select(loadStable, currentVersion, manual ? AppUpdateSource.Manual : AppUpdateSource.Auto)
      : loadStable();
  }

  private async fetchDevUpdateInfo(
    currentVersion: string,
  ): Promise<{ info: AppUpdateInfo | null; devCheck: FlowDevCheckResult | null }> {
    if (!this.devUpdates) return { info: null, devCheck: null };
    const candidate = this.devUpdates.trustStore.getReadyCandidate();
    const candidateRef = candidate
      ? { releaseId: candidate.releasePayload.releaseId, sha256: candidate.fileHash }
      : null;

    let result = await this.devUpdates.client.checkForUpdate(currentVersion, candidateRef);
    if (!result.updateFound || !result.releasePayload || !result.info) {
      return { info: result.info, devCheck: null };
    }

    // Followup: candidate=allowed followup before download
    const releaseId = result.releasePayload.releaseId;
    const sha256 = result.releasePayload.sha256;
    const version = result.releasePayload.version;
    if (!candidateRef || candidateRef.releaseId !== releaseId || candidateRef.sha256.toLowerCase() !== sha256.toLowerCase()) {
      const boundCheck = await this.devUpdates.client.authorizeCandidateForDownload(result.releasePayload, currentVersion);
      if (
        !boundCheck.updateFound
        || !boundCheck.channelEnvelope
        || !boundCheck.releasePayload
        || !boundCheck.info
        || boundCheck.releasePayload.releaseId !== releaseId
        || boundCheck.releasePayload.sha256.toLowerCase() !== sha256.toLowerCase()
        || boundCheck.releasePayload.version !== version
        || boundCheck.info.latestVersion !== version
        || boundCheck.info.dev?.releaseId !== releaseId
        || boundCheck.info.dev?.sha256.toLowerCase() !== sha256.toLowerCase()
        || this.devUpdates.trustStore.isDenied(releaseId, sha256)
        || this.devUpdates.trustStore.isDenied(boundCheck.releasePayload.releaseId, boundCheck.releasePayload.sha256)
      ) {
        return { info: null, devCheck: null };
      }
      result = boundCheck;
    }

    const verifiedAt = Math.floor(Date.now() / 1000);
    return {
      info: result.info,
      devCheck: {
        checkResult: result,
        verifiedAt,
      },
    };
  }

  private async fetchStableUpdateInfo(
    currentVersion: string,
    manual: boolean,
    userId?: string | null,
  ): Promise<AppUpdateInfo | null> {
    const baseUrl = manual ? getManualUpdateCheckUrl() : getUpdateCheckUrl();
    const qs = this.getUpdateQueryString(userId, currentVersion);
    const url = qs ? `${baseUrl}?${qs}` : baseUrl;
    console.log(`[AppUpdate] checking update, currentVersion=${currentVersion}, url=${url}`);

    const response = await session.defaultSession.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Update check failed (HTTP ${response.status})`);
    }

    const payload = (await response.json()) as UpdateApiResponse;
    if (payload.code !== 0) {
      throw new Error(`Update check failed with code ${payload.code ?? 'unknown'}`);
    }

    const value = payload.data?.value;
    const latestVersion = value?.version?.trim();
    if (!latestVersion || !this.isNewerVersion(latestVersion, currentVersion)) {
      console.log(
        `[AppUpdate] no update available, latestVersion=${latestVersion || 'N/A'}, currentVersion=${currentVersion}`,
      );
      return null;
    }

    const toEntry = (log?: ChangeLogLang) => ({
      title: typeof log?.title === 'string' ? log.title : '',
      content: Array.isArray(log?.content) ? log.content : [],
    });

    const result: AppUpdateInfo = {
      latestVersion,
      date: value?.date?.trim() || '',
      changeLog: {
        zh: toEntry(value?.changeLog?.ch),
        en: toEntry(value?.changeLog?.en),
      },
      url: this.getPlatformDownloadUrl(value),
    };
    console.log(
      `[AppUpdate] update available: ${currentVersion} -> ${latestVersion}, downloadUrl=${formatUpdateUrlForLog(result.url)}`,
    );
    return result;
  }

  private getPlatformDownloadUrl(
    value: NonNullable<NonNullable<UpdateApiResponse['data']>['value']> | undefined,
  ): string {
    if (process.platform === 'darwin') {
      const download = process.arch === 'arm64' ? value?.macArm : value?.macIntel;
      return download?.url?.trim() || getFallbackDownloadUrl();
    }

    if (process.platform === 'win32') {
      const candidate = value?.windowsX64?.url?.trim();
      if (!candidate) {
        return getFallbackDownloadUrl();
      }
      try {
        assertTrustedWindowsInstallerUrl(candidate);
      } catch (error) {
        const reason = error instanceof AppUpdateUrlUntrustedError
          ? error.reason
          : 'unknown';
        console.error(
          `[AppUpdate] update API returned an unsafe Windows installer URL, reason=${reason}`,
        );
        throw error;
      }
      return candidate;
    }

    return getFallbackDownloadUrl();
  }

  private canPredownload(url: string, info?: AppUpdateInfo): boolean {
    if (info?.dev) {
      return true;
    }
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return false;
    }
    return this.isDirectInstallerUrl(url);
  }

  private isDirectInstallerUrl(url: string): boolean {
    if (!url || isManualDownloadUrl(url)) {
      return false;
    }
    if (process.platform === 'darwin') {
      try {
        return new URL(url).pathname.toLowerCase().endsWith('.dmg');
      } catch {
        return false;
      }
    }
    if (process.platform === 'win32') {
      return validateWindowsInstallerUrl(url).trusted;
    }
    return false;
  }

  private isUpdateDisabled(): boolean {
    const enterprise = this.store.get<{ disableUpdate?: boolean }>('enterprise_config');
    return enterprise?.disableUpdate === true;
  }

  private isDefenderExclusionDisabled(): boolean {
    const enterprise = this.store.get<{ disableDefenderExclusion?: boolean }>('enterprise_config');
    return enterprise?.disableDefenderExclusion === true;
  }

  private resolveCurrentVersion(): string {
    const overriddenVersion = process.env[APP_UPDATE_TEST_CURRENT_VERSION_ENV]?.trim();
    if (overriddenVersion) {
      console.log(
        `[AppUpdate] using overridden current version from ${APP_UPDATE_TEST_CURRENT_VERSION_ENV}: ${overriddenVersion}`,
      );
      return overriddenVersion;
    }

    return app.getVersion();
  }

  private getUpdateQueryString(userId?: string | null, version?: string): string {
    const params = new URLSearchParams();
    const installationId = this.getOrCreateInstallationId();
    if (installationId) {
      params.append('uuid', installationId);
    }
    if (userId) {
      params.append('userId', userId);
    }
    if (version) {
      params.append('version', version);
    }
    const { firstKeyfrom, latestKeyfrom } = getKeyfromAttribution(this.store);
    params.set('firstKeyfrom', firstKeyfrom);
    params.set('latestKeyfrom', latestKeyfrom);
    return params.toString();
  }

  private getOrCreateInstallationId(): string | null {
    try {
      const existing = this.store.get<string>(INSTALLATION_UUID_KEY);
      if (typeof existing === 'string' && existing.trim()) {
        return existing;
      }
      const nextId = crypto.randomUUID();
      this.store.set(INSTALLATION_UUID_KEY, nextId);
      return nextId;
    } catch (error) {
      console.warn('[AppUpdate] failed to get installation uuid:', error);
      return null;
    }
  }

  private isNewerVersion(latestVersion: string, currentVersion: string): boolean {
    return this.compareVersions(latestVersion, currentVersion) > 0;
  }

  private compareVersions(a: string, b: string): number {
    const aParts = this.toVersionParts(a);
    const bParts = this.toVersionParts(b);
    const maxLength = Math.max(aParts.length, bParts.length);

    for (let index = 0; index < maxLength; index += 1) {
      const left = aParts[index] ?? 0;
      const right = bParts[index] ?? 0;
      if (left > right) return 1;
      if (left < right) return -1;
    }

    return 0;
  }

  private toVersionParts(version: string): number[] {
    return version.split('.').map(part => {
      const match = part.trim().match(/^\d+/);
      return match ? Number.parseInt(match[0], 10) : 0;
    });
  }

  private setState(nextState: AppUpdateRuntimeState): AppUpdateRuntimeState {
    this.state = { ...nextState };
    const snapshot = this.getState();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AppUpdateIpc.StateChanged, snapshot);
      }
    }
    return snapshot;
  }

  private beginFlow(source: AppUpdateSource, reason: string): number {
    const flowId = ++this.flowSequence;
    this.activeFlowId = flowId;
    this.activeFlowSource = source;
    console.log(`[AppUpdate] begin flow, flowId=${flowId}, source=${source}, reason=${reason}`);
    return flowId;
  }

  private isFlowActive(flowId: number, source: AppUpdateSource): boolean {
    return this.activeFlowId === flowId && this.activeFlowSource === source;
  }

  private async cleanupReadyFile(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }
    if (!this.isExpectedReadyInstallerPath(filePath)) {
      console.warn(
        `[AppUpdate] refused to delete a ready-file path outside the managed update cache: ${filePath}`,
      );
      return;
    }
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Best effort cleanup only.
    }
  }

  private canMutateCapturedCandidate(captured: {
    filePath?: string | null;
    fileHash?: string | null;
    releaseId?: string | null;
  }): boolean {
    if (this.devUpdates && captured.releaseId) {
      const currentReady = this.devUpdates.trustStore.getReadyCandidate();
      if (!currentReady) return false;
      if (
        currentReady.releasePayload.releaseId !== captured.releaseId
        || (captured.fileHash && currentReady.fileHash.toLowerCase() !== captured.fileHash.toLowerCase())
        || (captured.filePath && currentReady.filePath !== captured.filePath)
      ) {
        return false;
      }
    }
    if (captured.filePath && this.state.readyFilePath !== captured.filePath) {
      return false;
    }
    if (captured.fileHash && this.state.readyFileHash?.toLowerCase() !== captured.fileHash.toLowerCase()) {
      return false;
    }
    return true;
  }

  private async safeClearOwnedReady(owned: {
    filePath?: string | null;
    fileHash?: string | null;
    source?: AppUpdateSource | null;
    releaseId?: string | null;
  }): Promise<boolean> {
    if (owned.filePath) {
      await this.cleanupReadyFile(owned.filePath);
    }
    if (!this.canMutateCapturedCandidate(owned)) {
      console.warn('[AppUpdate] state changed during cleanup await, refusing to clear newer ready candidate');
      return false;
    }
    if (owned.source) {
      this.clearStoredReadyFile(owned.source);
    }
    if (this.devUpdates) {
      const currentReady = this.devUpdates.trustStore.getReadyCandidate();
      if (
        currentReady
        && (!owned.releaseId || currentReady.releasePayload.releaseId === owned.releaseId)
        && (!owned.fileHash || currentReady.fileHash.toLowerCase() === owned.fileHash.toLowerCase())
      ) {
        this.devUpdates.trustStore.clearReadyCandidate();
      }
    }
    return true;
  }

  private getUpdateCacheDir(): string {
    return path.join(app.getPath('userData'), 'updates');
  }

  private isCachedInstallerForSource(filename: string, source: AppUpdateSource | null): boolean {
    if (!filename.startsWith('lobsterai-update-')) {
      return false;
    }
    if (source == null) {
      return true;
    }
    if (filename.startsWith(`lobsterai-update-${source}-`)) {
      return true;
    }
    return /^lobsterai-update-\d+/.test(filename);
  }

  private isExpectedReadyInstallerPath(filePath: string): boolean {
    const cacheDir = path.resolve(this.getUpdateCacheDir());
    const resolvedFilePath = path.resolve(filePath);
    const normalize = (value: string) =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(path.dirname(resolvedFilePath)) !== normalize(cacheDir)) {
      return false;
    }

    const filename = path.basename(resolvedFilePath);
    if (!this.isCachedInstallerForSource(filename, null)) {
      return false;
    }
    const extension = path.extname(filename).toLowerCase();
    if (process.platform === 'win32') {
      return extension === '.exe';
    }
    if (process.platform === 'darwin') {
      return extension === '.dmg';
    }
    return extension === '.exe' || extension === '.dmg';
  }

  private getDynamicKeepFilePaths(): string[] {
    const paths: (string | null | undefined)[] = [
      this.state.readyFilePath,
      this.getStoredReadyFile(AppUpdateSource.Auto)?.filePath,
      this.getStoredReadyFile(AppUpdateSource.Manual)?.filePath,
      this.devUpdates?.trustStore.getReadyCandidate()?.filePath,
    ];
    return paths.filter((p): p is string => Boolean(p));
  }

  private async pruneCachedInstallerFiles(
    source: AppUpdateSource | null,
    keepFilePaths: string[] = [],
    isStillCurrent?: (() => boolean) | number,
  ): Promise<void> {
    const checkCurrent = typeof isStillCurrent === 'function'
      ? isStillCurrent
      : typeof isStillCurrent === 'number'
        ? () => this.isFlowActive(isStillCurrent, source ?? AppUpdateSource.Auto)
        : undefined;

    const buildKeepSet = () => {
      const allPaths = [...keepFilePaths, ...this.getDynamicKeepFilePaths()];
      return new Set(allPaths.filter(Boolean).map(filePath => path.resolve(filePath)));
    };

    let keepSet = buildKeepSet();
    const cacheDir = this.getUpdateCacheDir();

    try {
      const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
      if (checkCurrent && !checkCurrent()) {
        console.log('[AppUpdate] prune aborted after readdir: flow preempted');
        return;
      }
      for (const entry of entries) {
        if (checkCurrent && !checkCurrent()) {
          console.log('[AppUpdate] prune aborted before entry processing: flow preempted');
          return;
        }
        if (entry.isDirectory() && entry.name.startsWith(MAC_UPDATE_MOUNT_DIR_PREFIX)) {
          // Explicit mount point dir left behind by a failed macOS install.
          // rmdir only succeeds once nothing is mounted there, so a live
          // mount is never disturbed.
          await fs.promises.rmdir(path.resolve(cacheDir, entry.name)).catch(() => {});
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!this.isCachedInstallerForSource(entry.name, source)) {
          continue;
        }
        const entryPath = path.resolve(cacheDir, entry.name);
        keepSet = buildKeepSet();
        if (keepSet.has(entryPath)) {
          continue;
        }
        if (checkCurrent && !checkCurrent()) {
          console.log('[AppUpdate] prune aborted before unlink: flow preempted');
          return;
        }
        await fs.promises.unlink(entryPath).catch(() => {});
        console.log(`[AppUpdate] pruned cached installer file: ${entryPath}`);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn('[AppUpdate] failed to prune cached installer files:', error);
      }
    }
  }

  private async resolveMatchingReadyFile(
    previousState: AppUpdateRuntimeState,
    targetSource: AppUpdateSource,
    selected: AppUpdateInfo,
  ): Promise<StoredReadyFile | null> {
    const latestVersion = selected.latestVersion;
    if (selected.dev && this.devUpdates) {
      const readyCand = this.devUpdates.trustStore.getReadyCandidate();
      if (
        readyCand
        && readyCand.version === selected.latestVersion
        && readyCand.fileHash === selected.dev.sha256.toLowerCase()
        && !this.devUpdates.trustStore.isDenied(selected.dev.releaseId, selected.dev.sha256)
      ) {
        const isValid = await this.isReadyFileValid(readyCand.filePath, readyCand.fileHash);
        if (isValid) {
          return {
            version: readyCand.version,
            filePath: readyCand.filePath,
            fileHash: readyCand.fileHash,
            info: selected,
          };
        }
      }
      return null;
    }
    console.log(
      `[AppUpdate] resolveMatchingReadyFile started, targetSource=${targetSource}, previousStatus=${previousState.status}, previousSource=${previousState.source ?? 'none'}, previousVersion=${previousState.info?.latestVersion ?? 'none'}, latestVersion=${latestVersion}`,
    );
    const inMemoryReadyFile =
      previousState.source === targetSource &&
      previousState.status === AppUpdateStatus.Ready &&
      previousState.info?.latestVersion === latestVersion &&
      canReuseUpdatePackage(previousState.info, selected) &&
      previousState.readyFilePath != null &&
      previousState.readyFileHash != null
        ? {
            version: latestVersion,
            filePath: previousState.readyFilePath,
            fileHash: previousState.readyFileHash,
            info: previousState.info,
            windowsInstallerUrlPolicyReceipt:
              this.getReadyWindowsInstallerReceipt({
                version: latestVersion,
                filePath: previousState.readyFilePath,
                fileHash: previousState.readyFileHash,
                source: previousState.source,
              }),
          }
        : null;

    if (inMemoryReadyFile) {
      console.log(
        `[AppUpdate] checking in-memory ready file: ${inMemoryReadyFile.filePath}`,
      );
      if (!this.isTrustedWindowsReadyInstallerInfo(
        inMemoryReadyFile.info,
        inMemoryReadyFile.windowsInstallerUrlPolicyReceipt,
      )) {
        await this.cleanupReadyFile(inMemoryReadyFile.filePath);
        this.clearStoredReadyFile(previousState.source);
        this.readyWindowsInstallerTrust = null;
      } else {
        const isValid = await this.isReadyFileValid(
          inMemoryReadyFile.filePath,
          inMemoryReadyFile.fileHash,
        );
        if (isValid) {
          console.log('[AppUpdate] in-memory ready file is valid');
          return inMemoryReadyFile;
        }
        console.warn('[AppUpdate] in-memory ready file is invalid');
      }
    }

    // A matching installer may have been downloaded by the other flow (e.g. a
    // manual check after the auto updater already fetched this version), so
    // consider both persisted records, preferring the target source's own.
    const candidateSources =
      targetSource === AppUpdateSource.Manual
        ? [AppUpdateSource.Manual, AppUpdateSource.Auto]
        : [AppUpdateSource.Auto, AppUpdateSource.Manual];
    for (const source of candidateSources) {
      const storedReadyFile = this.getStoredReadyFile(source);
      if (!storedReadyFile || storedReadyFile.version !== latestVersion
          || !canReuseUpdatePackage(storedReadyFile.info, selected)) {
        console.log(
          `[AppUpdate] stored ready file mismatch, source=${source}, storedVersion=${storedReadyFile?.version ?? 'none'}, latestVersion=${latestVersion}`,
        );
        continue;
      }

      console.log(
        `[AppUpdate] checking persisted ready file: ${storedReadyFile.filePath}`,
      );
      if (!this.isTrustedWindowsReadyInstallerInfo(
        storedReadyFile.info,
        storedReadyFile.windowsInstallerUrlPolicyReceipt,
      )) {
        await this.cleanupReadyFile(storedReadyFile.filePath);
        this.clearStoredReadyFile(source);
        continue;
      }
      const isValid = await this.isReadyFileValid(
        storedReadyFile.filePath,
        storedReadyFile.fileHash,
      );
      if (isValid) {
        console.log(`[AppUpdate] persisted ready file from source=${source} is valid`);
        return storedReadyFile;
      }

      console.warn(
        `[AppUpdate] persisted ready file is invalid, deleting: ${storedReadyFile.filePath}`,
      );
      await this.cleanupReadyFile(storedReadyFile.filePath);
      this.clearStoredReadyFile(source);
    }
    return null;
  }

  private async isReadyFileValid(
    filePath: string,
    expectedHash: string,
  ): Promise<boolean> {
    try {
      if (!this.isExpectedReadyInstallerPath(filePath)) {
        console.warn(
          `[AppUpdate] ready file validation failed: path is outside the managed update cache, path=${filePath}`,
        );
        return false;
      }
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
        console.warn(
          `[AppUpdate] ready file validation failed: file missing or empty, path=${filePath}`,
        );
        return false;
      }
      const actualHash = await this.computeFileHash(filePath);
      if (actualHash !== expectedHash) {
        console.warn(
          `[AppUpdate] ready file validation failed: hash mismatch, path=${filePath}, expectedHash=${expectedHash}, actualHash=${actualHash}`,
        );
      }
      return actualHash === expectedHash;
    } catch {
      console.warn(
        `[AppUpdate] ready file validation failed: stat/hash threw, path=${filePath}`,
      );
      return false;
    }
  }

  private async computeFileHash(filePath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('error', reject);
      stream.on('data', chunk => {
        hash.update(chunk);
      });
      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });
    });
  }

  private async restoreStoredReadyStateAsync(): Promise<void> {
    if (this.devUpdates) {
      try {
        const restored = await this.devUpdates.trustStore.restoreReadyCandidate();
        if (!restored) {
          console.log('[AppUpdate] no verified dev ready candidate restored');
          this.clearStoredReadyFile(AppUpdateSource.Auto);
          this.clearStoredReadyFile(AppUpdateSource.Manual);
          void this.pruneCachedInstallerFiles(null);
          return;
        }

        const { record, info } = restored;
        const currentVersion = this.resolveCurrentVersion();
        if (this.compareVersions(record.version, currentVersion) <= 0) {
          if (record.installAttempted && this.compareVersions(record.version, currentVersion) === 0) {
            this.completedUpdateVersion = record.version;
          }
          this.devUpdates.trustStore.clearReadyCandidate();
          this.clearStoredReadyFile(AppUpdateSource.Auto);
          this.clearStoredReadyFile(AppUpdateSource.Manual);
          void this.cleanupReadyFile(record.filePath);
          void this.pruneCachedInstallerFiles(null);
          return;
        }

        this.state = {
          status: AppUpdateStatus.Ready,
          source: AppUpdateSource.Auto,
          info,
          progress: null,
          readyFilePath: record.filePath,
          readyFileHash: record.fileHash,
          errorMessage: null,
          installIncomplete: record.installAttempted,
        };
        void this.pruneCachedInstallerFiles(null, [record.filePath]);
        this.notifyStateChanged();
      } catch (err) {
        console.warn('[AppUpdate] failed to restore dev ready candidate:', err);
      }
      return;
    }

    this.restoreLegacyStoredReadyState();
  }

  private restoreLegacyStoredReadyState(): void {
    const sources: AppUpdateSource[] = [AppUpdateSource.Manual, AppUpdateSource.Auto];
    let restored = false;

    for (const source of sources) {
      const storedReadyFile = this.getStoredReadyFile(source);
      if (!storedReadyFile) {
        continue;
      }

      // Keep legacy stable restore unchanged. Gray requires a new check after restart.
      if (storedReadyFile.info?.gray
          && this.compareVersions(storedReadyFile.version, this.resolveCurrentVersion()) > 0) {
        this.clearStoredReadyFile(source);
        void this.cleanupReadyFile(storedReadyFile.filePath);
        continue;
      }

      console.log(
        `[AppUpdate] restoring persisted ready file, source=${source}, version=${storedReadyFile.version}, filePath=${storedReadyFile.filePath}`,
      );

      if (this.compareVersions(storedReadyFile.version, this.resolveCurrentVersion()) <= 0) {
        console.log(
          `[AppUpdate] persisted ready file is not newer than current version, clearing it: source=${source}, storedVersion=${storedReadyFile.version}, currentVersion=${this.resolveCurrentVersion()}`,
        );
        // An attempted install whose version the app is now running means the
        // installer completed and relaunched us — surface it once in the UI.
        if (
          storedReadyFile.installAttempted === true &&
          this.compareVersions(storedReadyFile.version, this.resolveCurrentVersion()) === 0
        ) {
          console.log(
            `[AppUpdate] detected completed update to version ${storedReadyFile.version}`,
          );
          this.completedUpdateVersion = storedReadyFile.version;
        }
        this.clearStoredReadyFile(source);
        void this.pruneCachedInstallerFiles(source);
        continue;
      }

      if (!this.isTrustedWindowsReadyInstallerInfo(
        storedReadyFile.info,
        storedReadyFile.windowsInstallerUrlPolicyReceipt,
      )) {
        this.clearStoredReadyFile(source);
        void this.cleanupReadyFile(storedReadyFile.filePath);
        void this.pruneCachedInstallerFiles(source);
        continue;
      }

      try {
        if (!this.isExpectedReadyInstallerPath(storedReadyFile.filePath)) {
          console.warn(
            `[AppUpdate] persisted ready file is outside the managed update cache: ${storedReadyFile.filePath}`,
          );
          this.clearStoredReadyFile(source);
          void this.cleanupReadyFile(storedReadyFile.filePath);
          continue;
        }
        const stat = fs.lstatSync(storedReadyFile.filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
          console.warn(
            `[AppUpdate] persisted ready file is missing or empty during startup restore: ${storedReadyFile.filePath}`,
          );
          this.clearStoredReadyFile(source);
          void this.pruneCachedInstallerFiles(source);
          continue;
        }
      } catch {
        console.warn(
          `[AppUpdate] persisted ready file stat failed during startup restore: ${storedReadyFile.filePath}`,
        );
        this.clearStoredReadyFile(source);
        void this.pruneCachedInstallerFiles(source);
        continue;
      }

      this.state = {
        status: AppUpdateStatus.Ready,
        source,
        info: storedReadyFile.info ?? this.createStoredReadyInfo(storedReadyFile.version),
        progress: null,
        readyFilePath: storedReadyFile.filePath,
        readyFileHash: storedReadyFile.fileHash,
        errorMessage: null,
        installIncomplete: storedReadyFile.installAttempted === true,
      };
      this.bindReadyWindowsInstallerTrust(storedReadyFile);
      void this.pruneCachedInstallerFiles(source, [storedReadyFile.filePath]);
      console.log(
        `[AppUpdate] restored ready update into runtime state, source=${source}, version=${this.state.info?.latestVersion ?? 'none'}, filePath=${this.state.readyFilePath ?? 'none'}`,
      );
      restored = true;
      break;
    }

    if (!restored) {
      console.log('[AppUpdate] no persisted ready file found during startup restore');
      void this.pruneCachedInstallerFiles(AppUpdateSource.Manual);
      void this.pruneCachedInstallerFiles(AppUpdateSource.Auto);
    }
  }

  private notifyStateChanged(): void {
    const snapshot = this.getState();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AppUpdateIpc.StateChanged, snapshot);
      }
    }
  }

  private createStoredReadyInfo(version: string): AppUpdateInfo {
    return {
      latestVersion: version,
      date: '',
      changeLog: {
        zh: { title: '', content: [] },
        en: { title: '', content: [] },
      },
      url: '',
    };
  }

  private bindReadyWindowsInstallerTrust(record: StoredReadyFile): void {
    const receipt = record.windowsInstallerUrlPolicyReceipt;
    if (process.platform !== 'win32' || !receipt) {
      this.readyWindowsInstallerTrust = null;
      return;
    }
    this.readyWindowsInstallerTrust = {
      version: record.version,
      filePath: record.filePath,
      fileHash: record.fileHash,
      receipt,
    };
  }

  private getReadyWindowsInstallerReceipt(candidate: {
    version: string;
    filePath: string;
    fileHash: string;
    source: AppUpdateSource | null;
  }): WindowsInstallerUrlPolicyReceipt | undefined {
    const matches = (record: ReadyWindowsInstallerTrust | StoredReadyFile | null) =>
      record?.version === candidate.version
      && record.filePath === candidate.filePath
      && record.fileHash === candidate.fileHash;

    if (matches(this.readyWindowsInstallerTrust)) {
      return this.readyWindowsInstallerTrust?.receipt;
    }

    const stored = this.getStoredReadyFile(candidate.source);
    if (matches(stored)) {
      return stored?.windowsInstallerUrlPolicyReceipt;
    }
    return undefined;
  }

  private isTrustedWindowsReadyInstallerInfo(
    info?: AppUpdateInfo,
    receipt?: WindowsInstallerUrlPolicyReceipt,
  ): boolean {
    if (info?.dev) {
      return this.devUpdates != null && !this.devUpdates.trustStore.isDenied(info.dev.releaseId, info.dev.sha256);
    }
    if (process.platform !== 'win32') {
      return true;
    }

    const result = validateWindowsInstallerUrl(info?.url?.trim() ?? '');
    if ('reason' in result) {
      console.error(
        `[AppUpdate] rejected cached Windows installer source, reason=${result.reason}`,
      );
      return false;
    }

    const receiptTrusted =
      receipt?.policyVersion === WINDOWS_INSTALLER_URL_POLICY_VERSION
      && receipt.inputOrigin === result.url.origin
      && receipt.finalOrigin === result.url.origin
      && isSecureWindowsInstallerOrigin(receipt.inputOrigin)
      && isSecureWindowsInstallerOrigin(receipt.finalOrigin);
    if (!receiptTrusted) {
      console.error('[AppUpdate] rejected cached Windows installer source, reason=receipt-invalid');
    }
    return receiptTrusted;
  }

  private getReadyFileStoreKey(source: AppUpdateSource | null): string {
    return `${APP_UPDATE_READY_FILE_KEY_PREFIX}:${source ?? 'unknown'}`;
  }

  private getStoredReadyFile(source: AppUpdateSource | null): StoredReadyFile | null {
    try {
      const key = this.getReadyFileStoreKey(source);
      const value = this.store.get<StoredReadyFile>(key);
      if (!value?.version || !value.filePath || !value.fileHash) {
        console.log('[AppUpdate] persisted ready file record is missing required fields');
        return null;
      }
      console.log(
        `[AppUpdate] loaded persisted ready file record, source=${source ?? 'unknown'}, version=${value.version}, filePath=${value.filePath}`,
      );
      return value;
    } catch (error) {
      console.warn('[AppUpdate] failed to read stored ready file:', error);
      return null;
    }
  }

  private setStoredReadyFile(value: StoredReadyFile): void {
    try {
      const source = this.state.source ?? AppUpdateSource.Auto;
      this.store.set(this.getReadyFileStoreKey(source), value);
      console.log(
        `[AppUpdate] persisted ready file record, source=${source}, version=${value.version}, filePath=${value.filePath}`,
      );
    } catch (error) {
      console.warn('[AppUpdate] failed to persist ready file:', error);
    }
  }

  private clearStoredReadyFile(source: AppUpdateSource | null): void {
    if (source == null) {
      return;
    }
    try {
      this.store.delete(this.getReadyFileStoreKey(source));
      console.log(`[AppUpdate] cleared persisted ready file record for source=${source}`);
    } catch (error) {
      console.warn('[AppUpdate] failed to clear stored ready file:', error);
    }
  }
}
