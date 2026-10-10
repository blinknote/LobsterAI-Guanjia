'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  verifyArtifactDirectory,
  readCanonicalVersion,
  APPROVED_PROJECT_ID,
  REQUIRED_BRANCH,
  APPROVED_BRANCHES,
} = require('./artifact-identity.cjs');

const FIXED_UPDATE_BASE_URL = 'https://updates.a-j.app';
const REQUIRED_CHUNK_SIZE = 16 * 1024 * 1024; // strictly 16 MiB (16,777,216 bytes)
const CONTROL_TIMEOUT_MS = 15 * 1000; // 15 seconds
const CHUNK_TIMEOUT_MS = 90 * 1000; // 90 seconds
const JOB_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes hard job limit
const MAX_RESPONSE_BODY_BYTES = 128 * 1024; // 128 KiB metadata response limit (design §4.1)
const MAX_EXTRA_RETRIES = 2; // max 2 extra retries (3 attempts total)
const UPLOAD_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_STATUSES = new Set(['receiving', 'validating', 'validated', 'published', 'rejected', 'expired']);

const jobStartTimestamp = Date.now();
const jobDeadlineTimestamp = jobStartTimestamp + JOB_TIMEOUT_MS;

// Hard wall clock timeout to guarantee process termination within 20 minutes
const hardWallTimer = setTimeout(() => {
  console.error('[ImportWindows] Hard 20-minute job deadline exhausted. Terminating process.');
  process.exit(1);
}, JOB_TIMEOUT_MS);
hardWallTimer.unref();

/**
 * Sanitize error messages to ensure tokens/secrets are never printed.
 * @param {string} message
 * @param {string} token
 * @returns {string}
 */
function sanitizeMessage(message, token) {
  if (!message || typeof message !== 'string') return '';
  let sanitized = message;
  if (token && token.length > 4) {
    sanitized = sanitized.split(token).join('[REDACTED]');
  }
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]');
  return sanitized;
}

/**
 * Safe HTTP request using bounded streaming to strictly prevent allocating unbounded bytes.
 * Abort timer covers the entire request and streaming response body read.
 * @param {string} url
 * @param {object} options
 * @param {number} timeoutMs
 * @param {string} token
 * @param {number} maxBodyBytes
 * @returns {Promise<{ status: number, ok: boolean, data: any, rawText: string }>}
 */
async function safeRequest(url, options = {}, timeoutMs = CONTROL_TIMEOUT_MS, token = '', maxBodyBytes = MAX_RESPONSE_BODY_BYTES) {
  const remainingBudgetMs = jobDeadlineTimestamp - Date.now();
  if (remainingBudgetMs <= 0) {
    throw new Error('Total 20-minute import job budget exhausted');
  }
  const effectiveTimeout = Math.min(timeoutMs, remainingBudgetMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual', // Strictly forbid following redirects
    });

    // Detect HTTP redirects (301, 302, 303, 307, 308, opaqueredirect)
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      throw new Error(`HTTP redirect (status ${res.status}) detected. Redirects are strictly forbidden on update routes.`);
    }

    // Check Content-Length header against maxBodyBytes if present
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > maxBodyBytes) {
        throw new Error(`Response body Content-Length (${contentLength} bytes) exceeds limit of ${maxBodyBytes} bytes`);
      }
    }

    // Bounded stream consumption: read chunk by chunk, aborting immediately if bytes exceed limit
    const chunks = [];
    let receivedBytes = 0;

    if (res.body) {
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            receivedBytes += value.length;
            if (receivedBytes > maxBodyBytes) {
              await reader.cancel();
              throw new Error(`Response body stream exceeded limit of ${maxBodyBytes} bytes`);
            }
            chunks.push(Buffer.from(value));
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    const fullBuffer = Buffer.concat(chunks);
    const rawText = fullBuffer.toString('utf8');
    let data = null;
    if (rawText.trim().length > 0) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      data,
      rawText,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request to ${url} timed out after ${effectiveTimeout}ms`);
    }
    const cleanMsg = sanitizeMessage(err.message || String(err), token);
    throw new Error(cleanMsg);
  } finally {
    // Timer cleared only AFTER body stream is completely consumed and closed
    clearTimeout(timer);
  }
}

/**
 * Sleep for specified milliseconds, respecting job deadline.
 * @param {number} ms
 */
async function safeSleep(ms) {
  const remainingBudgetMs = jobDeadlineTimestamp - Date.now();
  const actualSleep = Math.min(ms, Math.max(0, remainingBudgetMs));
  if (actualSleep > 0) {
    await new Promise((resolve) => setTimeout(resolve, actualSleep));
  }
}

/**
 * Main entry point for import-windows.
 */
async function runImport() {
  console.log('==> [ImportWindows] Initializing Windows Dev update import...');

  // 1. Validate authentication token (ONLY exact LOBSTERAI_UPDATES_IMPORT_TOKEN, no fallbacks)
  const token = (process.env.LOBSTERAI_UPDATES_IMPORT_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'Authentication failed: missing required environment variable LOBSTERAI_UPDATES_IMPORT_TOKEN. ' +
      'Import cannot proceed without authentication.'
    );
  }

  // 2. Validate current environment project/branch context
  if (process.env.CIRCLE_PROJECT_ID && process.env.CIRCLE_PROJECT_ID !== APPROVED_PROJECT_ID) {
    throw new Error(`Unauthorized CIRCLE_PROJECT_ID in environment: expected "${APPROVED_PROJECT_ID}", got "${process.env.CIRCLE_PROJECT_ID}"`);
  }
  const currentBranch = (process.env.CIRCLE_BRANCH || (process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_REF_NAME : '') || '').trim();
  if (currentBranch && !APPROVED_BRANCHES.has(currentBranch)) {
    throw new Error(`Unauthorized branch in environment: expected one of ${Array.from(APPROVED_BRANCHES).join(', ')}, got "${currentBranch}"`);
  }

  // 3. Read canonical version from current checkout package.json (MUST succeed, no null fallback)
  const repoRoot = path.resolve(__dirname, '..');
  const canonicalVersion = readCanonicalVersion(repoRoot);
  console.log(`==> [ImportWindows] Canonical version from current checkout: ${canonicalVersion}`);

  // 4. Locate and verify workflow workspace installer artifacts (EXCLUSIVELY workflow workspace, NO fallback)
  const customTargetDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const workspaceTargetDir = path.resolve('.circleci-workspace/installer');
  const artifactsTargetDir = path.resolve('artifacts/windows');
  const targetDir = customTargetDir
    || ((fs.existsSync(workspaceTargetDir) && fs.existsSync(path.join(workspaceTargetDir, 'UPDATE_IDENTITY.json')))
      ? workspaceTargetDir
      : artifactsTargetDir);
  if (!fs.existsSync(targetDir) || !fs.existsSync(path.join(targetDir, 'UPDATE_IDENTITY.json'))) {
    throw new Error(
      `Missing installer artifacts at: ${targetDir}. ` +
      'Import job requires artifacts containing UPDATE_IDENTITY.json.'
    );
  }

  console.log(`==> [ImportWindows] Located workflow workspace in: ${targetDir}`);
  const currentSha = process.env.CIRCLE_SHA1 || (process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_SHA : undefined);
  const { identity, binaryPath } = await verifyArtifactDirectory(
    targetDir,
    currentSha,
    canonicalVersion
  );

  console.log(`==> [ImportWindows] Verified identity for:`);
  console.log(`    Product: ${identity.product}`);
  console.log(`    App ID: ${identity.appId}`);
  console.log(`    Channel: ${identity.channel}`);
  console.log(`    Platform: ${identity.platform}`);
  console.log(`    Arch: ${identity.arch}`);
  console.log(`    Version: ${identity.version}`);
  console.log(`    Commit: ${identity.sourceCommit}`);
  console.log(`    File: ${identity.fileName} (${identity.size} bytes)`);
  console.log(`    SHA256: ${identity.sha256}`);
  console.log(`    PE Machine: ${identity.packagedApp.peMachine}`);

  // 5. Initiate or resume import session via POST /api/v1/imports
  console.log(`==> [ImportWindows] Initiating import session with ${FIXED_UPDATE_BASE_URL}/api/v1/imports...`);

  let initResponse = null;
  let initAttempts = 0;
  while (initAttempts <= MAX_EXTRA_RETRIES) {
    initAttempts++;
    try {
      const res = await safeRequest(
        `${FIXED_UPDATE_BASE_URL}/api/v1/imports`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-store',
          },
          body: JSON.stringify(identity),
        },
        CONTROL_TIMEOUT_MS,
        token
      );

      if (res.ok && res.data) {
        initResponse = res.data;
        break;
      }

      const errorMsg = sanitizeMessage(
        res.data?.error?.message || `HTTP ${res.status}: ${res.rawText.substring(0, 200)}`,
        token
      );

      // Client errors (4xx) must fail immediately without retry
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Server rejected import creation (${res.status}): ${errorMsg}`);
      }

      // 5xx server error, may retry if attempts remain
      if (initAttempts > MAX_EXTRA_RETRIES) {
        throw new Error(`Server error initiating import (${res.status}): ${errorMsg}`);
      }
      console.warn(`[ImportWindows] Init attempt ${initAttempts} failed with ${res.status}, retrying in 2s...`);
      await safeSleep(2000);
    } catch (err) {
      if (err.message && err.message.includes('Server rejected import creation')) {
        throw err;
      }
      if (initAttempts > MAX_EXTRA_RETRIES) {
        throw err;
      }
      console.warn(`[ImportWindows] Init attempt ${initAttempts} failed (${sanitizeMessage(err.message, token)}), retrying in 2s...`);
      await safeSleep(2000);
    }
  }

  if (!initResponse || !initResponse.success || !initResponse.data) {
    throw new Error(`Invalid init response structure from server: ${JSON.stringify(initResponse)}`);
  }

  const uploadData = initResponse.data;

  // Strict validation of server init response (no path injection, strict values)
  const uploadId = uploadData.uploadId;
  if (!uploadId || typeof uploadId !== 'string' || !UPLOAD_ID_REGEX.test(uploadId)) {
    throw new Error(`Invalid or unsafe uploadId received from server: "${uploadId}"`);
  }

  const status = uploadData.status;
  if (!status || !VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status received from server: "${status}"`);
  }

  // If status is already published, exit successfully (idempotent result)
  if (status === 'published') {
    console.log(`==> [ImportWindows] Release is already published (uploadId: ${uploadId}, releaseId: ${uploadData.releaseId || 'unknown'}).`);
    console.log(`==> [ImportWindows] Import succeeded idempotently.`);
    return;
  }

  // Strictly verify chunkSize from server equals 16 MiB
  if (uploadData.chunkSize !== REQUIRED_CHUNK_SIZE) {
    throw new Error(`Unexpected chunkSize from server: expected ${REQUIRED_CHUNK_SIZE}, received ${uploadData.chunkSize}`);
  }
  const chunkSize = REQUIRED_CHUNK_SIZE;
  const totalChunks = Math.ceil(identity.size / chunkSize);

  // Validate receivedChunks array strictly
  if (!Array.isArray(uploadData.receivedChunks)) {
    throw new Error('Server receivedChunks must be an array');
  }
  for (const idx of uploadData.receivedChunks) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= totalChunks) {
      throw new Error(`Invalid chunk index in server receivedChunks: ${idx}`);
    }
  }
  const receivedChunks = new Set(uploadData.receivedChunks);

  console.log(`==> [ImportWindows] Upload session established:`);
  console.log(`    Upload ID: ${uploadId}`);
  console.log(`    Status: ${status}`);
  console.log(`    Chunk Size: ${chunkSize} bytes (16 MiB)`);
  console.log(`    Total Chunks: ${totalChunks}`);
  console.log(`    Already Received Chunks: ${receivedChunks.size}/${totalChunks}`);

  // 6. Upload missing chunks via PUT /api/v1/imports/<uploadId>/chunks/<index>
  const fd = fs.openSync(binaryPath, 'r');
  try {
    for (let index = 0; index < totalChunks; index++) {
      if (receivedChunks.has(index)) {
        console.log(`    Chunk ${index + 1}/${totalChunks} already received, skipping.`);
        continue;
      }

      const start = index * chunkSize;
      const length = Math.min(chunkSize, identity.size - start);
      const chunkBuffer = Buffer.alloc(length);
      fs.readSync(fd, chunkBuffer, 0, length, start);

      const chunkSha256 = crypto.createHash('sha256').update(chunkBuffer).digest('hex').toLowerCase();

      let chunkUploaded = false;
      let chunkAttempts = 0;

      while (chunkAttempts <= MAX_EXTRA_RETRIES) {
        chunkAttempts++;
        const remainingMs = jobDeadlineTimestamp - Date.now();
        if (remainingMs <= 0) {
          throw new Error('20-minute job deadline exceeded during chunk upload');
        }

        try {
          const chunkRes = await safeRequest(
            `${FIXED_UPDATE_BASE_URL}/api/v1/imports/${encodeURIComponent(uploadId)}/chunks/${index}`,
            {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(length),
                'X-Chunk-SHA256': chunkSha256,
                'Authorization': `Bearer ${token}`,
                'Cache-Control': 'no-store',
              },
              body: chunkBuffer,
            },
            CHUNK_TIMEOUT_MS,
            token
          );

          if (chunkRes.ok) {
            console.log(`    Chunk ${index + 1}/${totalChunks} uploaded successfully (${length} bytes).`);
            chunkUploaded = true;
            break;
          }

          // 409 Conflict: different bytes on server for this index. Must fail immediately without retry!
          if (chunkRes.status === 409) {
            throw new Error(`Chunk ${index} conflict (409): server reports mismatched chunk bytes. Cannot continue.`);
          }

          const errMsg = sanitizeMessage(
            chunkRes.data?.error?.message || `HTTP ${chunkRes.status}`,
            token
          );

          if (chunkRes.status >= 400 && chunkRes.status < 500) {
            throw new Error(`Server rejected chunk ${index} (${chunkRes.status}): ${errMsg}`);
          }

          if (chunkAttempts > MAX_EXTRA_RETRIES) {
            throw new Error(`Failed to upload chunk ${index} after ${chunkAttempts} attempts: ${errMsg}`);
          }

          console.warn(`    Chunk ${index + 1}/${totalChunks} attempt ${chunkAttempts} failed (${errMsg}), retrying in 2s...`);
          await safeSleep(2000);
        } catch (err) {
          if (err.message && (err.message.includes('conflict (409)') || err.message.includes('Server rejected chunk'))) {
            throw err;
          }
          if (chunkAttempts > MAX_EXTRA_RETRIES) {
            throw new Error(`Failed to upload chunk ${index} after ${chunkAttempts} attempts: ${sanitizeMessage(err.message, token)}`);
          }
          console.warn(`    Chunk ${index + 1}/${totalChunks} attempt ${chunkAttempts} error (${sanitizeMessage(err.message, token)}), retrying in 2s...`);
          await safeSleep(2000);
        }
      }

      if (!chunkUploaded) {
        throw new Error(`Chunk ${index + 1}/${totalChunks} could not be uploaded.`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  console.log(`==> [ImportWindows] All ${totalChunks} chunks uploaded successfully.`);

  // 7. Complete and publish via POST /api/v1/imports/<uploadId>/complete
  // Rule: unknown complete state switches to bounded GET polling only, never re-POST complete.
  console.log(`==> [ImportWindows] Completing import session ${uploadId}...`);

  let needPolling = false;
  let finalReleaseId = null;
  let finalStatus = null;

  try {
    const completeRes = await safeRequest(
      `${FIXED_UPDATE_BASE_URL}/api/v1/imports/${encodeURIComponent(uploadId)}/complete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({}),
      },
      CONTROL_TIMEOUT_MS,
      token
    );

    if (completeRes.ok && completeRes.data) {
      const completeBody = completeRes.data;
      if (completeBody.success && completeBody.data) {
        finalStatus = completeBody.data.status;
        finalReleaseId = completeBody.data.releaseId;
        if (finalStatus !== 'published') {
          console.log(`[ImportWindows] Complete returned status "${finalStatus}", initiating bounded status polling...`);
          needPolling = true;
        }
      } else {
        needPolling = true;
      }
    } else if (completeRes.status >= 500) {
      // Server 5xx: unknown whether publication succeeded. Switch to GET polling without re-POST.
      console.warn(`[ImportWindows] Server returned ${completeRes.status} on complete; switching to bounded GET polling without re-POST.`);
      needPolling = true;
    } else {
      // Client error 4xx: fail clearly
      const errMsg = sanitizeMessage(
        completeRes.data?.error?.message || `HTTP ${completeRes.status}`,
        token
      );
      throw new Error(`Server rejected complete request (${completeRes.status}): ${errMsg}`);
    }
  } catch (err) {
    if (err.message && err.message.includes('Server rejected complete request')) {
      throw err;
    }
    // Network error or timeout: unknown complete state. Switch to bounded GET polling!
    console.warn(
      `[ImportWindows] Complete request produced unknown state (${sanitizeMessage(err.message, token)}). ` +
      `Switching to bounded GET polling without repeating complete request.`
    );
    needPolling = true;
  }

  // 8. Bounded GET polling if required
  if (needPolling) {
    console.log(`==> [ImportWindows] Polling import status for uploadId: ${uploadId}...`);
    const maxPollAttempts = 12; // 12 * 5s = 60s max polling time
    const pollIntervalMs = 5000;
    let isPublished = false;

    for (let pollAttempt = 1; pollAttempt <= maxPollAttempts; pollAttempt++) {
      const remainingMs = jobDeadlineTimestamp - Date.now();
      if (remainingMs <= 10000) {
        throw new Error(`Job deadline approaching during status polling for uploadId ${uploadId}`);
      }

      await safeSleep(pollIntervalMs);

      try {
        const pollRes = await safeRequest(
          `${FIXED_UPDATE_BASE_URL}/api/v1/imports/${encodeURIComponent(uploadId)}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Cache-Control': 'no-store',
            },
          },
          CONTROL_TIMEOUT_MS,
          token
        );

        if (pollRes.ok && pollRes.data) {
          const pollBody = pollRes.data;
          const currentStatus = pollBody?.data?.status;
          const currentReleaseId = pollBody?.data?.releaseId;
          console.log(`    Poll ${pollAttempt}/${maxPollAttempts}: status = "${currentStatus}"`);

          if (currentStatus === 'published') {
            finalStatus = 'published';
            finalReleaseId = currentReleaseId;
            isPublished = true;
            break;
          } else if (currentStatus === 'rejected') {
            throw new Error(`Import was rejected by server: ${pollBody?.data?.rejectionReason || 'unknown reason'}`);
          }
        }
      } catch (pollErr) {
        if (pollErr.message && pollErr.message.includes('Import was rejected by server')) {
          throw pollErr;
        }
        console.warn(`    Poll ${pollAttempt}/${maxPollAttempts} failed (${sanitizeMessage(pollErr.message, token)}), retrying...`);
      }
    }

    if (!isPublished && finalStatus !== 'published') {
      throw new Error(`Timed out waiting for upload ${uploadId} to reach published state.`);
    }
  }

  // 9. Success reporting
  console.log('==> [ImportWindows] Windows Dev update import completed successfully!');
  console.log(`    Upload ID: ${uploadId}`);
  console.log(`    Release ID: ${finalReleaseId || 'published'}`);
  console.log(`    Version: ${identity.version}`);
  console.log(`    Installer: ${identity.fileName}`);
  console.log(`    Size: ${identity.size} bytes`);
  console.log(`    SHA256: ${identity.sha256}`);
  console.log(`    Published Status: ${finalStatus || 'published'}`);
}

if (require.main === module) {
  runImport()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[ImportWindows] Fatal Error:', sanitizeMessage(err.message, process.env.LOBSTERAI_UPDATES_IMPORT_TOKEN));
      process.exit(1);
    });
}

module.exports = {
  FIXED_UPDATE_BASE_URL,
  REQUIRED_CHUNK_SIZE,
  CONTROL_TIMEOUT_MS,
  CHUNK_TIMEOUT_MS,
  JOB_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
  UPLOAD_ID_REGEX,
  VALID_STATUSES,
  sanitizeMessage,
  safeRequest,
  runImport,
};
