'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const EXPECTED_PRODUCT = 'LobsterAI-Dev';
const EXPECTED_APP_ID = 'com.lobsterai.dev.app';
const EXPECTED_CHANNEL = 'dev';
const EXPECTED_PLATFORM = 'win32';
const EXPECTED_ARCH = 'x64';
const EXPECTED_PACKAGE_TYPE = 'nsis-full';
const EXPECTED_PE_MACHINE = 34404; // 0x8664 = IMAGE_FILE_MACHINE_AMD64
const MAX_INSTALLER_SIZE = 1024 * 1024 * 1024; // 1 GiB hard limit
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVED_PROJECT_ID = '0482e18c-23dd-4029-a3f8-237687fe401d';
const REQUIRED_BRANCH = 'feat/smartbutler-integration';

/**
 * Extract a file from an asar archive using pure Node.js Buffer and fs.
 * Does not require external @electron/asar package or node_modules checkout.
 * @param {string} asarPath
 * @param {string} innerFilePath
 * @returns {Buffer}
 */
function extractFileFromAsar(asarPath, innerFilePath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const jsonSize = sizeBuf.readUInt32LE(12);
    const headerBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, headerBuf, 0, jsonSize, 16);
    const header = JSON.parse(headerBuf.toString('utf8'));

    // Walk header structure
    const segments = innerFilePath.replace(/^\/+/, '').split('/');
    let current = header;
    for (const segment of segments) {
      if (!current || !current.files || !current.files[segment]) {
        throw new Error(`File "${innerFilePath}" not found in asar archive "${asarPath}"`);
      }
      current = current.files[segment];
    }

    if (typeof current.offset !== 'string' || typeof current.size !== 'number') {
      throw new Error(`Invalid entry for "${innerFilePath}" in asar archive`);
    }

    const fileOffset = 8 + headerSize + parseInt(current.offset, 10);
    const fileBuf = Buffer.alloc(current.size);
    fs.readSync(fd, fileBuf, 0, current.size, fileOffset);
    return fileBuf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Safely parse exact named exported string-literal assignments from compiled appConstants.js.
 * Does not execute packaged code; fails on ambiguity, missing, or non-literal assignments.
 * @param {string} code
 * @returns {{ appName: string, appUserModelId: string }}
 */
function parseAppConstantsExports(code) {
  const extractExport = (name) => {
    const matches = [];
    let m;

    // 1. (exports|module.exports).NAME = 'literal'
    const r1 = new RegExp(`(?:exports|module\\.exports)\\.${name}\\s*=\\s*(['"])(.*?)\\1`, 'g');
    while ((m = r1.exec(code)) !== null) { matches.push(m[2]); }

    // 2. (exports|module.exports)['NAME'] = 'literal'
    const r2 = new RegExp(`(?:exports|module\\.exports)\\[['"]${name}['"]\\]\\s*=\\s*(['"])(.*?)\\1`, 'g');
    while ((m = r2.exec(code)) !== null) { matches.push(m[2]); }

    // 3. export const NAME = 'literal'
    const r3 = new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\s*=\\s*(['"])(.*?)\\1`, 'g');
    while ((m = r3.exec(code)) !== null) { matches.push(m[2]); }

    if (matches.length === 0) {
      // Reject non-literal assignments
      const nonLiteral = code.match(new RegExp(`(?:exports|module\\.exports)\\.${name}\\s*=\\s*([^;\\n]+)`));
      if (nonLiteral && !nonLiteral[1].trim().startsWith('void 0')) {
        throw new Error(`Non-literal or unresolvable export assignment for ${name}: "${nonLiteral[1].trim()}"`);
      }
      return null;
    }

    const unique = Array.from(new Set(matches));
    if (unique.length > 1) {
      throw new Error(`Ambiguous conflicting export assignments found for ${name}: ${unique.join(', ')}`);
    }
    return unique[0];
  };

  const appName = extractExport('APP_NAME');
  const appUserModelId = extractExport('APP_USER_MODEL_ID');

  if (!appName) {
    throw new Error('Unable to extract exact exported string-literal assignment for APP_NAME from packaged appConstants');
  }
  if (!appUserModelId) {
    throw new Error('Unable to extract exact exported string-literal assignment for APP_USER_MODEL_ID from packaged appConstants');
  }

  return { appName, appUserModelId };
}

/**
 * Read canonical version from root package.json.
 * @param {string} repoRoot
 * @returns {string}
 */
function readCanonicalVersion(repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Missing canonical package.json at ${pkgPath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.version || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`Invalid or missing version in canonical package.json: "${pkg.version}" (must be X.Y.Z)`);
  }
  return pkg.version;
}

/**
 * Parse PE header from buffer to extract machine type.
 * @param {Buffer} buffer
 * @returns {{ peOffset: number, machine: number }}
 */
function parsePeHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) {
    throw new Error('Buffer is too small to contain a valid PE header (<64 bytes)');
  }
  // DOS Header magic 'MZ' (0x5A4D)
  if (buffer[0] !== 0x4D || buffer[1] !== 0x5A) {
    throw new Error('Not a valid DOS executable (missing MZ header magic 0x5A4D)');
  }
  // e_lfanew at offset 0x3C
  const peOffset = buffer.readUInt32LE(0x3C);
  if (buffer.length < peOffset + 6) {
    throw new Error(`Buffer truncated before PE header at offset ${peOffset}`);
  }
  // PE signature 'PE\0\0' (0x00004550)
  const peSig = buffer.subarray(peOffset, peOffset + 4).toString('ascii');
  if (peSig !== 'PE\0\0') {
    throw new Error(`Invalid PE signature at offset ${peOffset}: ${JSON.stringify(peSig)}`);
  }
  // Machine type is uint16 LE at peOffset + 4
  const machine = buffer.readUInt16LE(peOffset + 4);
  return { peOffset, machine };
}

/**
 * Inspect PE file on disk to verify x64 machine (34404) and compute SHA256.
 * @param {string} filePath
 * @returns {Promise<{ peMachine: number, sha256: string, size: number }>}
 */
async function inspectPeExecutable(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Executable file does not exist: ${filePath}`);
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`Executable file is empty, symlink, or not a regular file: ${filePath}`);
  }

  // Read first 4096 bytes to extract PE header
  const headerBuf = Buffer.alloc(Math.min(stat.size, 4096));
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const { machine } = parsePeHeader(headerBuf);
  if (machine !== EXPECTED_PE_MACHINE) {
    throw new Error(`PE executable machine type mismatch in ${filePath}: expected ${EXPECTED_PE_MACHINE} (x64), got ${machine}`);
  }

  // Stream SHA256 hash
  const sha256 = await computeFileSha256(filePath);
  return {
    peMachine: machine,
    sha256,
    size: stat.size,
  };
}

/**
 * Compute SHA256 hash of a file using streams.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Resolve 40-character source commit from CIRCLE_SHA1 and git rev-parse HEAD.
 * Mismatches strictly FAIL without warning or fallback guessing.
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveSourceCommit(repoRoot) {
  const circleSha = (process.env.CIRCLE_SHA1 || '').trim().toLowerCase();
  let gitCommit = '';
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
  } catch {
    gitCommit = '';
  }

  if (circleSha && gitCommit) {
    if (circleSha !== gitCommit) {
      throw new Error(`Source commit mismatch: CIRCLE_SHA1 (${circleSha}) does not match git rev-parse HEAD (${gitCommit}).`);
    }
  }

  const finalCommit = circleSha || gitCommit;
  if (!finalCommit || !/^[0-9a-f]{40}$/.test(finalCommit)) {
    throw new Error(`Unable to resolve 40-character sourceCommit: "${finalCommit}" is not a valid 40-character hex commit.`);
  }

  return finalCommit;
}

/**
 * Resolve and validate provenance from environment variables without fake defaults.
 * @returns {{ projectId: string, pipelineId: string, workflowId: string, jobId: string, branch: string }}
 */
function resolveProvenance() {
  const projectId = (process.env.CIRCLE_PROJECT_ID || '').trim();
  if (!projectId || !UUID_REGEX.test(projectId)) {
    throw new Error(`Missing or invalid CIRCLE_PROJECT_ID UUID in provenance: "${projectId}"`);
  }
  if (projectId !== APPROVED_PROJECT_ID) {
    throw new Error(`Unauthorized CIRCLE_PROJECT_ID in provenance: expected "${APPROVED_PROJECT_ID}", got "${projectId}"`);
  }

  const pipelineId = (process.env.CIRCLE_PIPELINE_ID || '').trim();
  if (!pipelineId || !UUID_REGEX.test(pipelineId)) {
    throw new Error(`Missing or invalid CIRCLE_PIPELINE_ID UUID in provenance: "${pipelineId}"`);
  }

  const workflowId = (process.env.CIRCLE_WORKFLOW_ID || '').trim();
  if (!workflowId || !UUID_REGEX.test(workflowId)) {
    throw new Error(`Missing or invalid CIRCLE_WORKFLOW_ID UUID in provenance: "${workflowId}"`);
  }

  const jobId = (process.env.CIRCLE_WORKFLOW_JOB_ID || '').trim();
  if (!jobId || !UUID_REGEX.test(jobId)) {
    throw new Error(`Missing or invalid CIRCLE_WORKFLOW_JOB_ID UUID in provenance: "${jobId}"`);
  }

  const branch = (process.env.CIRCLE_BRANCH || '').trim();
  if (!branch) {
    throw new Error('Missing CIRCLE_BRANCH in provenance');
  }
  if (branch !== REQUIRED_BRANCH) {
    throw new Error(`Unauthorized CIRCLE_BRANCH in provenance: expected "${REQUIRED_BRANCH}", got "${branch}"`);
  }

  return {
    projectId,
    pipelineId,
    workflowId,
    jobId,
    branch,
  };
}

/**
 * Build structured changeLog according to design.md §4.2:
 * "缺少可信变更说明时保持空，不编造功能。"
 * @param {string} repoRoot
 * @param {string} version
 * @returns {{ zh: { title: string, content: string[] }, en: { title: string, content: string[] } }}
 */
function resolveChangeLog(repoRoot, version) {
  const notesPath = path.join(repoRoot, `release-notes-${version}.json`);
  if (fs.existsSync(notesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
      if (parsed?.zh?.title && Array.isArray(parsed?.zh?.content) && parsed?.en?.title && Array.isArray(parsed?.en?.content)) {
        return parsed;
      }
    } catch {
      // Fall through to empty content
    }
  }

  return {
    zh: {
      title: `LobsterAI-Dev ${version}`,
      content: [],
    },
    en: {
      title: `LobsterAI-Dev ${version}`,
      content: [],
    },
  };
}

/**
 * Stamp build identity marker JSON into dist-electron before packaging.
 * This file is packaged wholesale into app.asar by electron-builder.
 * @param {string} repoRoot
 */
function stampBuildMarker(repoRoot = path.resolve(__dirname, '..')) {
  console.log(`==> [ArtifactIdentity] Stamping build marker in: ${repoRoot}`);
  const canonicalVersion = readCanonicalVersion(repoRoot);
  const sourceCommit = resolveSourceCommit(repoRoot);

  const ebPath = path.join(repoRoot, 'electron-builder.json');
  if (!fs.existsSync(ebPath)) {
    throw new Error(`Missing electron-builder.json at ${ebPath}`);
  }
  const ebConfig = JSON.parse(fs.readFileSync(ebPath, 'utf8'));
  if (ebConfig.productName !== EXPECTED_PRODUCT) {
    throw new Error(`electron-builder.json productName mismatch: expected "${EXPECTED_PRODUCT}", got "${ebConfig.productName}"`);
  }
  if (ebConfig.appId !== EXPECTED_APP_ID) {
    throw new Error(`electron-builder.json appId mismatch: expected "${EXPECTED_APP_ID}", got "${ebConfig.appId}"`);
  }

  const distElectronDir = path.join(repoRoot, 'dist-electron');
  if (!fs.existsSync(distElectronDir)) {
    fs.mkdirSync(distElectronDir, { recursive: true });
  }

  const marker = {
    productName: ebConfig.productName,
    appId: ebConfig.appId,
    version: canonicalVersion,
    sourceCommit,
    builtAt: new Date().toISOString(),
  };

  const markerPath = path.join(distElectronDir, 'build-identity.json');
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  console.log(`==> [ArtifactIdentity] Build marker stamped at ${markerPath}: version=${canonicalVersion}, commit=${sourceCommit}`);
}

/**
 * Collect verified installer and generate UPDATE_IDENTITY.json & BUILD_INFO.txt.
 * Extracts metadata exclusively from packaged app.asar and built PE executable.
 * @param {string} repoRoot
 */
async function collectArtifactIdentity(repoRoot = path.resolve(__dirname, '..')) {
  console.log(`==> [ArtifactIdentity] Starting artifact binding in: ${repoRoot}`);

  // 1. Derive canonical version from root package.json
  const canonicalVersion = readCanonicalVersion(repoRoot);
  console.log(`    Canonical package version: ${canonicalVersion}`);

  // 2. Resolve source commit strictly
  const sourceCommit = resolveSourceCommit(repoRoot);
  console.log(`    Source Commit: ${sourceCommit}`);

  // 3. Inspect actual unpacked build artifacts: app.asar and PE executable
  const releaseDir = path.join(repoRoot, 'release');
  const winUnpackedDir = path.join(releaseDir, 'win-unpacked');
  if (!fs.existsSync(winUnpackedDir)) {
    throw new Error(`Missing win-unpacked build directory: ${winUnpackedDir}`);
  }

  // Extract and inspect actual build-identity.json inside resources/app.asar
  const appAsarPath = path.join(winUnpackedDir, 'resources', 'app.asar');
  if (!fs.existsSync(appAsarPath)) {
    throw new Error(`Missing packaged app.asar at: ${appAsarPath}`);
  }

  const markerBuf = extractFileFromAsar(appAsarPath, 'dist-electron/build-identity.json');
  const marker = JSON.parse(markerBuf.toString('utf8'));
  if (!marker.productName || marker.productName !== EXPECTED_PRODUCT) {
    throw new Error(`Packaged build-identity.json productName mismatch in app.asar: expected "${EXPECTED_PRODUCT}", got "${marker.productName}"`);
  }
  if (!marker.appId || marker.appId !== EXPECTED_APP_ID) {
    throw new Error(`Packaged build-identity.json appId mismatch in app.asar: expected "${EXPECTED_APP_ID}", got "${marker.appId}"`);
  }
  if (!marker.version || marker.version !== canonicalVersion) {
    throw new Error(`Packaged build-identity.json version mismatch in app.asar: expected "${canonicalVersion}", got "${marker.version}"`);
  }
  if (!marker.sourceCommit || marker.sourceCommit.toLowerCase() !== sourceCommit.toLowerCase()) {
    throw new Error(`Packaged build-identity.json commit mismatch in app.asar: expected "${sourceCommit}", got "${marker.sourceCommit}"`);
  }
  console.log(`==> [ArtifactIdentity] Verified app.asar packaged build-identity.json matches commit ${sourceCommit}`);

  // Extract and inspect actual package.json inside resources/app.asar
  const appPkgBuf = extractFileFromAsar(appAsarPath, 'package.json');
  const appPkg = JSON.parse(appPkgBuf.toString('utf8'));
  if (!appPkg.version || appPkg.version !== canonicalVersion) {
    throw new Error(`Packaged app.asar package.json version mismatch: expected "${canonicalVersion}", got "${appPkg.version}"`);
  }

  // Extract and inspect actual appConstants inside resources/app.asar
  const appConstantsBuf = extractFileFromAsar(appAsarPath, 'dist-electron/main/appConstants.js');
  const appConstantsCode = appConstantsBuf.toString('utf8');
  const { appName, appUserModelId } = parseAppConstantsExports(appConstantsCode);
  if (appName !== EXPECTED_PRODUCT) {
    throw new Error(`Packaged appConstants APP_NAME export mismatch: expected "${EXPECTED_PRODUCT}", got "${appName}"`);
  }
  if (appUserModelId !== EXPECTED_APP_ID) {
    throw new Error(`Packaged appConstants APP_USER_MODEL_ID export mismatch: expected "${EXPECTED_APP_ID}", got "${appUserModelId}"`);
  }
  if (appName !== marker.productName) {
    throw new Error(`Packaged appConstants APP_NAME "${appName}" does not match marker productName "${marker.productName}"`);
  }
  if (appUserModelId !== marker.appId) {
    throw new Error(`Packaged appConstants APP_USER_MODEL_ID "${appUserModelId}" does not match marker appId "${marker.appId}"`);
  }
  console.log(`==> [ArtifactIdentity] Verified app.asar packaged appConstants exact exports: APP_NAME="${appName}", APP_USER_MODEL_ID="${appUserModelId}"`);

  // Inspect PE executable
  const executableName = marker.productName;
  const unpackedExePath = path.join(winUnpackedDir, `${executableName}.exe`);
  if (!fs.existsSync(unpackedExePath)) {
    throw new Error(`Missing unpacked executable: ${unpackedExePath}`);
  }

  console.log(`==> [ArtifactIdentity] Inspecting unpacked PE: ${unpackedExePath}`);
  const unpackedPe = await inspectPeExecutable(unpackedExePath);
  console.log(`    PE Machine: ${unpackedPe.peMachine} (x64)`);
  console.log(`    Executable SHA256: ${unpackedPe.sha256}`);
  console.log(`    Executable Size: ${unpackedPe.size} bytes`);

  // 4. Scan release directory for newly produced full NSIS Dev installer anchored to x64-version-official
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory does not exist: ${releaseDir}`);
  }

  const installerRegex = new RegExp(
    `^LobsterAI-Dev-Setup-x64-${canonicalVersion.replace(/\\./g, '\\.')}-official(?:-silent)?\\.exe$`,
    'i'
  );

  const allEntries = fs.readdirSync(releaseDir, { withFileTypes: true });
  const installerCandidates = allEntries.filter((entry) => {
    if (!entry.isFile()) return false;
    const name = entry.name;
    if (!name.endsWith('.exe')) return false;
    // Exclude web installer stubs
    if (/websetup/i.test(name) || /-web-/i.test(name)) return false;
    // Exclude uninstallers
    if (/uninstall/i.test(name)) return false;
    return installerRegex.test(name);
  }).map((entry) => entry.name);

  if (installerCandidates.length === 0) {
    throw new Error(
      `No full NSIS Dev installer found in ${releaseDir} matching pattern: LobsterAI-Dev-Setup-x64-${canonicalVersion}-official.exe`
    );
  }
  if (installerCandidates.length > 1) {
    throw new Error(
      `Ambiguous installers found in ${releaseDir}: expected exactly 1, found ${installerCandidates.length} (${installerCandidates.join(', ')})`
    );
  }

  const installerFileName = installerCandidates[0];
  const installerFilePath = path.join(releaseDir, installerFileName);
  const installerStat = fs.lstatSync(installerFilePath);

  if (!installerStat.isFile() || installerStat.isSymbolicLink() || installerStat.size <= 0) {
    throw new Error(`Installer file is empty, symlink, or not a regular file: ${installerFilePath}`);
  }
  if (installerStat.size > MAX_INSTALLER_SIZE) {
    throw new Error(`Installer file size (${installerStat.size} bytes) exceeds 1 GiB limit (${MAX_INSTALLER_SIZE} bytes)`);
  }

  console.log(`==> [ArtifactIdentity] Computing installer SHA256 for: ${installerFileName}`);
  const installerSha256 = await computeFileSha256(installerFilePath);
  console.log(`    Installer Size: ${installerStat.size} bytes`);
  console.log(`    Installer SHA256: ${installerSha256}`);

  // 5. Build changeLog without fake invented features
  const changeLog = resolveChangeLog(repoRoot, canonicalVersion);

  // 6. Build provenance strictly
  const provenance = resolveProvenance();

  // 7. Build packagedApp from actual measured metadata inside ASAR & PE binary
  const packagedApp = {
    productName: appName,
    appId: appUserModelId,
    version: marker.version,
    sourceCommit: marker.sourceCommit,
    arch: EXPECTED_ARCH,
    peMachine: unpackedPe.peMachine,
    executableSha256: unpackedPe.sha256,
  };

  // 8. Build UPDATE_IDENTITY.json with flattened scope (exact wire contract)
  const identity = {
    schemaVersion: 1,
    product: appName,
    appId: appUserModelId,
    channel: EXPECTED_CHANNEL,
    platform: EXPECTED_PLATFORM,
    arch: EXPECTED_ARCH,
    packageType: EXPECTED_PACKAGE_TYPE,
    version: canonicalVersion,
    sourceCommit,
    fileName: installerFileName,
    size: installerStat.size,
    sha256: installerSha256,
    changeLog,
    provenance,
    packagedApp,
  };

  // 9. Build BUILD_INFO.txt
  const buildDate = new Date().toISOString();
  const buildInfoText = [
    `Commit: ${sourceCommit}`,
    `BuildDate: ${buildDate}`,
    '',
    `${installerSha256}  ${installerFileName}`,
    '',
  ].join('\n');

  // 10. Write outputs to target directories
  const targetDirs = [
    path.join(repoRoot, 'artifacts', 'windows'),
    path.join(repoRoot, '.circleci-workspace', 'installer'),
  ];

  for (const targetDir of targetDirs) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Copy installer binary
    const destExePath = path.join(targetDir, installerFileName);
    fs.copyFileSync(installerFilePath, destExePath);

    // Write UPDATE_IDENTITY.json
    const identityPath = path.join(targetDir, 'UPDATE_IDENTITY.json');
    fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n', 'utf8');

    // Write BUILD_INFO.txt
    const buildInfoPath = path.join(targetDir, 'BUILD_INFO.txt');
    fs.writeFileSync(buildInfoPath, buildInfoText, 'utf8');

    console.log(`==> [ArtifactIdentity] Written to ${targetDir}:`);
    console.log(`    - ${installerFileName} (${installerStat.size} bytes)`);
    console.log(`    - UPDATE_IDENTITY.json`);
    console.log(`    - BUILD_INFO.txt`);
  }

  console.log(`==> [ArtifactIdentity] Collection and verification completed successfully.`);
  return { identity, installerFileName, installerFilePath };
}

/**
 * Verify identity and files in an existing directory.
 * Strict check: no extra EXEs tolerated, BUILD_INFO is required, safe regular marker paths,
 * expectedVersion is strictly required and matched, workflowId must match active workflow when set.
 * @param {string} dir
 * @param {string} [expectedCommit]
 * @param {string} expectedVersion
 * @returns {Promise<object>}
 */
async function verifyArtifactDirectory(dir, expectedCommit, expectedVersion) {
  if (!expectedVersion || typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error(`expectedVersion parameter is strictly required for verifyArtifactDirectory (received: "${expectedVersion}")`);
  }

  if (!fs.existsSync(dir)) {
    throw new Error(`Directory does not exist: ${dir}`);
  }

  // Enforce regular files and no extra files/markers in workspace directory
  const allDirEntries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of allDirEntries) {
    const entryPath = path.join(dir, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic link detected in workspace directory: ${entryPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Non-regular file entry in workspace directory: ${entryPath}`);
    }
  }

  const identityPath = path.join(dir, 'UPDATE_IDENTITY.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error(`Missing UPDATE_IDENTITY.json in ${dir}`);
  }

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));

  if (identity.schemaVersion !== 1) {
    throw new Error(`Invalid schemaVersion: expected 1, found ${identity.schemaVersion}`);
  }
  if (identity.product !== EXPECTED_PRODUCT) {
    throw new Error(`Invalid product: expected ${EXPECTED_PRODUCT}, found ${identity.product}`);
  }
  if (identity.appId !== EXPECTED_APP_ID) {
    throw new Error(`Invalid appId: expected ${EXPECTED_APP_ID}, found ${identity.appId}`);
  }
  if (identity.channel !== EXPECTED_CHANNEL) {
    throw new Error(`Invalid channel: expected ${EXPECTED_CHANNEL}, found ${identity.channel}`);
  }
  if (identity.platform !== EXPECTED_PLATFORM) {
    throw new Error(`Invalid platform: expected ${EXPECTED_PLATFORM}, found ${identity.platform}`);
  }
  if (identity.arch !== EXPECTED_ARCH) {
    throw new Error(`Invalid arch: expected ${EXPECTED_ARCH}, found ${identity.arch}`);
  }
  if (identity.packageType !== EXPECTED_PACKAGE_TYPE) {
    throw new Error(`Invalid packageType: expected ${EXPECTED_PACKAGE_TYPE}, found ${identity.packageType}`);
  }
  if (identity.version !== expectedVersion) {
    throw new Error(`Invalid version: expected current checkout version "${expectedVersion}", found "${identity.version}"`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(identity.version)) {
    throw new Error(`Invalid version format: ${identity.version}`);
  }
  if (!identity.sourceCommit || !/^[0-9a-f]{40}$/i.test(identity.sourceCommit)) {
    throw new Error(`Invalid sourceCommit format: ${identity.sourceCommit}`);
  }
  if (expectedCommit && identity.sourceCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(`sourceCommit mismatch: expected ${expectedCommit}, found ${identity.sourceCommit}`);
  }

  // Validate safe fileName without path traversal or directory components, anchored to x64-version-official
  if (!identity.fileName || typeof identity.fileName !== 'string') {
    throw new Error('Missing or invalid fileName in identity');
  }
  if (path.basename(identity.fileName) !== identity.fileName || identity.fileName.includes('/') || identity.fileName.includes('\\') || identity.fileName.includes('..')) {
    throw new Error(`Unsafe fileName path components detected: "${identity.fileName}"`);
  }
  const expectedFileNameRegex = new RegExp(
    `^LobsterAI-Dev-Setup-x64-${identity.version.replace(/\\./g, '\\.')}-official(?:-silent)?\\.exe$`,
    'i'
  );
  if (!expectedFileNameRegex.test(identity.fileName)) {
    throw new Error(`identity.fileName "${identity.fileName}" does not match exact anchored naming convention for version ${identity.version}`);
  }

  // Validate provenance strictly
  if (!identity.provenance || typeof identity.provenance !== 'object') {
    throw new Error('Missing provenance object in identity');
  }
  if (identity.provenance.projectId !== APPROVED_PROJECT_ID) {
    throw new Error(`Unauthorized projectId in provenance: expected "${APPROVED_PROJECT_ID}", got "${identity.provenance.projectId}"`);
  }
  if (!UUID_REGEX.test(identity.provenance.pipelineId)) {
    throw new Error(`Invalid pipelineId UUID in provenance: "${identity.provenance.pipelineId}"`);
  }
  if (!UUID_REGEX.test(identity.provenance.workflowId)) {
    throw new Error(`Invalid workflowId UUID in provenance: "${identity.provenance.workflowId}"`);
  }
  if (!UUID_REGEX.test(identity.provenance.jobId)) {
    throw new Error(`Invalid jobId UUID in provenance: "${identity.provenance.jobId}"`);
  }
  if (identity.provenance.branch !== REQUIRED_BRANCH) {
    throw new Error(`Unauthorized branch in provenance: expected "${REQUIRED_BRANCH}", got "${identity.provenance.branch}"`);
  }

  // Cross-check provenance with active CI environment
  if (process.env.CIRCLE_PROJECT_ID && identity.provenance.projectId !== process.env.CIRCLE_PROJECT_ID) {
    throw new Error(`identity provenance.projectId (${identity.provenance.projectId}) does not match CIRCLE_PROJECT_ID (${process.env.CIRCLE_PROJECT_ID})`);
  }
  if (process.env.CIRCLE_BRANCH && identity.provenance.branch !== process.env.CIRCLE_BRANCH) {
    throw new Error(`identity provenance.branch (${identity.provenance.branch}) does not match CIRCLE_BRANCH (${process.env.CIRCLE_BRANCH})`);
  }
  if (process.env.CIRCLE_PIPELINE_ID && identity.provenance.pipelineId !== process.env.CIRCLE_PIPELINE_ID) {
    throw new Error(`identity provenance.pipelineId (${identity.provenance.pipelineId}) does not match CIRCLE_PIPELINE_ID (${process.env.CIRCLE_PIPELINE_ID})`);
  }
  if (process.env.CIRCLE_WORKFLOW_ID && identity.provenance.workflowId !== process.env.CIRCLE_WORKFLOW_ID) {
    throw new Error(`identity provenance.workflowId (${identity.provenance.workflowId}) does not match current workflow CIRCLE_WORKFLOW_ID (${process.env.CIRCLE_WORKFLOW_ID})`);
  }

  // Check structured changeLog
  if (!identity.changeLog || !identity.changeLog.zh || !identity.changeLog.en) {
    throw new Error('Missing structured changeLog (zh and en required)');
  }
  if (!identity.changeLog.zh.title || !Array.isArray(identity.changeLog.zh.content)) {
    throw new Error('Invalid changeLog.zh structure (title and content[] required)');
  }
  if (!identity.changeLog.en.title || !Array.isArray(identity.changeLog.en.content)) {
    throw new Error('Invalid changeLog.en structure (title and content[] required)');
  }

  // Check packagedApp consistency
  if (!identity.packagedApp || identity.packagedApp.peMachine !== EXPECTED_PE_MACHINE) {
    throw new Error(`Invalid packagedApp peMachine: expected ${EXPECTED_PE_MACHINE}`);
  }
  if (!identity.packagedApp.executableSha256 || !/^[0-9a-f]{64}$/i.test(identity.packagedApp.executableSha256)) {
    throw new Error('Invalid packagedApp executableSha256');
  }
  if (identity.packagedApp.version !== identity.version) {
    throw new Error(`packagedApp version mismatch: ${identity.packagedApp.version} vs ${identity.version}`);
  }
  if (identity.packagedApp.sourceCommit.toLowerCase() !== identity.sourceCommit.toLowerCase()) {
    throw new Error(`packagedApp sourceCommit mismatch: ${identity.packagedApp.sourceCommit} vs ${identity.sourceCommit}`);
  }

  // Check binary exists as regular file and verify no extra EXEs are tolerated
  const exeFiles = allDirEntries.filter((e) => e.name.endsWith('.exe'));
  if (exeFiles.length === 0) {
    throw new Error(`No installer executable found in directory: ${dir}`);
  }
  if (exeFiles.length > 1) {
    throw new Error(`Extra executable files tolerated error: expected exactly 1 EXE (${identity.fileName}), found: ${exeFiles.map(e => e.name).join(', ')}`);
  }
  if (exeFiles[0].name !== identity.fileName) {
    throw new Error(`Executable file name mismatch: expected "${identity.fileName}", found "${exeFiles[0].name}"`);
  }

  // Verify that only the 3 expected files exist in directory: installer, identity, BUILD_INFO
  const allowedNames = new Set([identity.fileName, 'UPDATE_IDENTITY.json', 'BUILD_INFO.txt']);
  for (const entry of allDirEntries) {
    if (!allowedNames.has(entry.name)) {
      throw new Error(`Unexpected extraneous file in workspace directory: "${entry.name}"`);
    }
  }

  const binaryPath = path.join(dir, identity.fileName);
  const stat = fs.lstatSync(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Installer binary is symlink or not a regular file: ${binaryPath}`);
  }
  if (stat.size !== identity.size) {
    throw new Error(`Binary size mismatch: expected ${identity.size}, got ${stat.size}`);
  }
  if (stat.size > MAX_INSTALLER_SIZE || stat.size <= 0) {
    throw new Error(`Invalid binary size: ${stat.size}`);
  }

  const computedSha = await computeFileSha256(binaryPath);
  if (computedSha.toLowerCase() !== identity.sha256.toLowerCase()) {
    throw new Error(`Binary SHA256 mismatch: expected ${identity.sha256}, got ${computedSha}`);
  }

  // Check BUILD_INFO.txt is strictly REQUIRED
  const buildInfoPath = path.join(dir, 'BUILD_INFO.txt');
  if (!fs.existsSync(buildInfoPath)) {
    throw new Error(`BUILD_INFO.txt is REQUIRED but missing in ${dir}`);
  }
  const buildInfoStat = fs.lstatSync(buildInfoPath);
  if (!buildInfoStat.isFile() || buildInfoStat.isSymbolicLink()) {
    throw new Error(`BUILD_INFO.txt is symlink or not a regular file: ${buildInfoPath}`);
  }
  const buildInfoContent = fs.readFileSync(buildInfoPath, 'utf8');
  if (!buildInfoContent.includes(identity.sourceCommit)) {
    throw new Error(`BUILD_INFO.txt does not contain sourceCommit ${identity.sourceCommit}`);
  }
  if (!buildInfoContent.includes(identity.sha256)) {
    throw new Error(`BUILD_INFO.txt does not contain installer SHA256 ${identity.sha256}`);
  }

  return { identity, binaryPath };
}

// CLI entry point
if (require.main === module) {
  const action = process.argv[2] || 'collect';
  if (action === 'collect') {
    collectArtifactIdentity()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[ArtifactIdentity] Error:', err.message);
        process.exit(1);
      });
  } else if (action === 'stamp') {
    try {
      stampBuildMarker();
      process.exit(0);
    } catch (err) {
      console.error('[ArtifactIdentity] Stamp error:', err.message);
      process.exit(1);
    }
  } else if (action === 'verify') {
    const targetDir = process.argv[3] || path.resolve('.circleci-workspace/installer');
    const repoRoot = path.resolve(__dirname, '..');
    let version = null;
    try {
      version = readCanonicalVersion(repoRoot);
    } catch {
      version = process.argv[4] || null;
    }
    if (!version) {
      console.error('[ArtifactIdentity] Error: expectedVersion parameter is required for verify');
      process.exit(1);
    }
    verifyArtifactDirectory(targetDir, process.env.CIRCLE_SHA1, version)
      .then(() => {
        console.log(`==> [ArtifactIdentity] Verified successfully in ${targetDir}`);
        process.exit(0);
      })
      .catch((err) => {
        console.error('[ArtifactIdentity] Verification failed:', err.message);
        process.exit(1);
      });
  } else {
    console.error(`Unknown action: ${action}`);
    process.exit(1);
  }
}

module.exports = {
  EXPECTED_PRODUCT,
  EXPECTED_APP_ID,
  EXPECTED_CHANNEL,
  EXPECTED_PLATFORM,
  EXPECTED_ARCH,
  EXPECTED_PACKAGE_TYPE,
  EXPECTED_PE_MACHINE,
  MAX_INSTALLER_SIZE,
  APPROVED_PROJECT_ID,
  REQUIRED_BRANCH,
  readCanonicalVersion,
  extractFileFromAsar,
  parsePeHeader,
  inspectPeExecutable,
  computeFileSha256,
  resolveSourceCommit,
  resolveProvenance,
  resolveChangeLog,
  parseAppConstantsExports,
  stampBuildMarker,
  collectArtifactIdentity,
  verifyArtifactDirectory,
};
