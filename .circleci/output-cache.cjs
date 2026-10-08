'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { stable, hashFile, treeDigest } = require('./dependency-cache.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = 1;
const OUTPUT_EPOCH = 1;
const TARGET = { image: 'windows-server-2022', platform: 'win32', arch: 'x64',
  node: '24.15.0', npm: '11.17.0', pnpm: '12.1.0', electron: '43.5.0' };

const CLIENT_PATHS = ['dist', 'dist-electron'];
const CLIENT_REQUIRED_FILES = [
  'dist/index.html',
  'dist/library-thumbnail.html',
  'dist-electron/main.js',
  'dist-electron/preload.js',
  'dist-electron/browserAnnotationPreload.js',
  'dist-electron/agentBrowserCredentialPreload.js',
  'dist-electron/manualCredentialCapturePreload.js',
  'dist-electron/guanjiaPreload.js',
];
const SKILLS_PATHS = [
  'SKILLs/web-search/node_modules',
  'SKILLs/web-search/dist',
  'SKILLs/web-search/package-lock.json',
  'SKILLs/imap-smtp-email/node_modules',
  'SKILLs/imap-smtp-email/package-lock.json',
  'SKILLs/pptx/node_modules',
  'SKILLs/pptx/package-lock.json',
  'SKILLs/technology-news-search/scripts/vendor/rss-parser.bundle.js',
];
const SKILLS_COLD_MISS_FORBIDDEN = [
  'SKILLs/web-search/node_modules',
  'SKILLs/web-search/dist',
  'SKILLs/web-search/package-lock.json',
  'SKILLs/imap-smtp-email/node_modules',
  'SKILLs/imap-smtp-email/package-lock.json',
  'SKILLs/pptx/node_modules',
  'SKILLs/pptx/package-lock.json',
];

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) {
  if (error.code === 'ENOENT') return false;
  throw error;
} };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const statePath = kind => `.circleci-output-state-${kind}.json`;
const manifestPath = kind => `.circleci-output-cache/${kind}.json`;

function safePath(relative) {
  const normalized = path.isAbsolute(relative) ? path.relative(ROOT, relative).split(path.sep).join('/') : relative;
  const parts = normalized.split('/');
  let current = ROOT;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (!exists(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error(`Output cache path is redirected: ${relative}`);
    }
  }
  return current;
}

const writeJson = (file, data) => {
  const target = safePath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
};

function checkEnvGuard() {
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'production') {
    throw new Error('Output cache requires production mode');
  }
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const file = path.join(ROOT, name);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      throw new Error(`Unmodeled custom env file detected: ${name}`);
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VITE_') && value && value.trim() !== '') {
      throw new Error(`Unmodeled custom Vite environment variable: ${key}`);
    }
  }
}

function checkToolchain() {
  if (process.platform !== TARGET.platform || process.arch !== TARGET.arch || process.versions.node !== TARGET.node) {
    throw new Error('Output cache requires Windows x64 and Node 24.15.0. Use fingerprint for diagnostics.');
  }
  const app = readJson(safePath('package.json'));
  if (app.devDependencies?.electron !== TARGET.electron) {
    throw new Error('Output cache Electron version pin does not match.');
  }
}

function getKeyfrom() {
  const raw = process.env.KEYFROM;
  if (typeof raw !== 'string') return 'official';
  const val = raw.trim().toLowerCase();
  return (val && /^[a-z0-9_-]{1,64}$/.test(val)) ? val : 'official';
}

function getDepInfo(dryRun) {
  const depStateFile = safePath('.circleci-dependency-state.json');
  const depManifestFile = safePath('.circleci-dependency-cache/manifest.json');
  const lockFile = safePath('package-lock.json');
  if (!exists(lockFile)) throw new Error('Missing package-lock.json');
  const currentLockDigest = hashFile(lockFile);

  if (dryRun && (!exists(depManifestFile) || !exists(depStateFile))) {
    return { key: 'dry-run-dep-key', treeSha256: 'dry-run-tree-sha', rootLockSha256: currentLockDigest };
  }
  if (!exists(depStateFile) || !exists(depManifestFile)) {
    throw new Error('Dependency cache must be restored and verified before output cache operations');
  }
  const depState = readJson(depStateFile);
  if (!depState.ready) throw new Error('Dependency state is not ready');
  const manifest = readJson(depManifestFile);
  const keyFile = safePath('.circleci-dependency-keys/root.txt');
  if (!exists(keyFile)) throw new Error('Missing dependency key file');
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  const hidden = safePath('node_modules/.package-lock.json');
  if (manifest.schema !== 1 || manifest.successfulInstall !== true || manifest.key !== key
    || manifest.nativePhase !== 'npm-install-pre-package' || !manifest.installed
    || manifest.installed.rootLockSha256 !== currentLockDigest
    || manifest.installed.hiddenLockSha256 !== (exists(hidden) ? hashFile(hidden) : null)) {
    throw new Error('Root package-lock.json digest does not match restored dependency manifest');
  }
  return {
    key: manifest.key,
    treeSha256: manifest.treeSha256,
    rootLockSha256: manifest.installed.rootLockSha256,
  };
}

function fingerprint(kind, dryRun = false) {
  checkEnvGuard();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected full checkout commit.');
  const depInfo = getDepInfo(dryRun);
  const identity = {
    schema: SCHEMA,
    epoch: OUTPUT_EPOCH,
    kind,
    target: TARGET,
    commit,
    depManifestKey: depInfo.key,
    depTreeSha256: depInfo.treeSha256,
    rootLockSha256: depInfo.rootLockSha256,
  };
  if (kind === 'client') {
    identity.keyfrom = getKeyfrom();
  }
  return { identity, key: hash(stable(identity)) };
}

function validateClientOutputs() {
  for (const rel of CLIENT_PATHS) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      throw new Error(`Expected client output directory missing: ${rel}`);
    }
  }
  for (const rel of CLIENT_REQUIRED_FILES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile() || fs.statSync(p).size === 0) {
      throw new Error(`Expected client output file missing or empty: ${rel}`);
    }
  }
}

async function snapshotPaths(paths) {
  const digests = {};
  for (const rel of paths.slice().sort()) {
    const full = path.join(ROOT, rel);
    let ancestor = ROOT;
    for (const part of rel.split('/')) {
      ancestor = path.join(ancestor, part);
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Redirected output path: ${rel}`);
    }
    if (!fs.existsSync(full)) throw new Error(`Missing expected cache path: ${rel}`);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      digests[rel] = await treeDigest(full);
    } else if (stat.isFile()) {
      if (stat.size === 0) throw new Error(`Output file is empty: ${rel}`);
      digests[rel] = hashFile(full);
    } else {
      throw new Error(`Output path must be regular file or directory: ${rel}`);
    }
  }
  return digests;
}

function checkColdMiss(kind) {
  const paths = kind === 'client' ? CLIENT_PATHS : SKILLS_COLD_MISS_FORBIDDEN;
  for (const rel of paths) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) {
      throw new Error(`${kind} output artifacts present without cache manifest; refusing unowned output: ${rel}`);
    }
  }
}

async function restore(kind, dryRun = false) {
  if (!dryRun) checkToolchain();
  writeJson(statePath(kind), { ready: false });
  const current = fingerprint(kind, dryRun);
  const manifestFile = safePath(manifestPath(kind));
  if (!exists(manifestFile)) {
    checkColdMiss(kind);
    console.log(`[output-cache] ${kind}: cold miss; original build required.`);
    return;
  }
  const saved = readJson(manifestFile);
  if (saved.schema !== SCHEMA || saved.epoch !== OUTPUT_EPOCH || saved.kind !== kind
    || saved.key !== current.key || stable(saved.identity) !== stable(current.identity)) {
    throw new Error(`${kind} output cache identity mismatch`);
  }
  if (kind === 'client') validateClientOutputs();
  const currentDigests = await snapshotPaths(kind === 'client' ? CLIENT_PATHS : SKILLS_PATHS);
  if (stable(currentDigests) !== stable(saved.digests)) {
    throw new Error(`${kind} output cache integrity mismatch`);
  }
  writeJson(statePath(kind), { ready: true, key: current.key });
  console.log(`[output-cache] ${kind}: verified cache hit; reused output.`);
}

async function capture(kind, flags, dryRun = false) {
  if (!dryRun) checkToolchain();
  writeJson(statePath(kind), { ready: false });
  if (kind === 'client') {
    if (!flags.includes('--build-succeeded') || !flags.includes('--compile-succeeded')) {
      throw new Error('Client capture requires both --build-succeeded and --compile-succeeded flags');
    }
    validateClientOutputs();
  } else if (kind === 'skills') {
    if (!flags.includes('--build-succeeded') || !flags.includes('--pptx-install-succeeded')) {
      throw new Error('Skills capture requires both --build-succeeded and --pptx-install-succeeded flags');
    }
  }
  const current = fingerprint(kind, dryRun);
  const digests = await snapshotPaths(kind === 'client' ? CLIENT_PATHS : SKILLS_PATHS);
  const manifest = {
    schema: SCHEMA,
    epoch: OUTPUT_EPOCH,
    kind,
    key: current.key,
    identity: current.identity,
    digests,
    capturedAt: new Date().toISOString(),
  };
  writeJson(manifestPath(kind), manifest);
  writeJson(statePath(kind), { ready: true, key: current.key });
  console.log(`[output-cache] ${kind}: successfully captured output.`);
}

function generateKeys(dryRun = false) {
  if (!dryRun) checkToolchain();
  const clientFp = fingerprint('client', dryRun);
  const skillsFp = fingerprint('skills', dryRun);
  const clientFile = safePath('.circleci-output-keys/client.txt');
  const skillsFile = safePath('.circleci-output-keys/skills.txt');
  fs.mkdirSync(path.dirname(clientFile), { recursive: true });
  fs.writeFileSync(clientFile, clientFp.key + '\n');
  fs.writeFileSync(skillsFile, skillsFp.key + '\n');
  console.log(`[output-cache] Output keys written: client (${clientFp.key}), skills (${skillsFp.key})`);
}

async function main() {
  const [command, kind, ...flags] = process.argv.slice(2);
  const dryRun = command === 'fingerprint';
  const allowed = command === 'capture'
    ? (kind === 'client' ? ['--build-succeeded', '--compile-succeeded'] : ['--build-succeeded', '--pptx-install-succeeded']) : [];
  if (flags.some(flag => !allowed.includes(flag))) throw new Error('Unsupported output cache flag');
  if (command === 'fingerprint') {
    const kinds = kind ? [kind] : ['client', 'skills'];
    for (const k of kinds) {
      console.log(JSON.stringify(fingerprint(k, true), null, 2));
    }
    return;
  }
  if (command === 'keys') {
    if (kind) throw new Error('Usage: output-cache.cjs keys takes no arguments');
    generateKeys(dryRun);
    return;
  }
  if (!['client', 'skills'].includes(kind)) {
    throw new Error('Usage: output-cache.cjs keys | restore client|skills | capture client|skills [flags]');
  }
  if (command === 'restore') {
    await restore(kind, dryRun);
  } else if (command === 'capture') {
    await capture(kind, flags, dryRun);
  } else {
    throw new Error('Unknown command: ' + command);
  }
}

module.exports = { fingerprint, restore, capture, generateKeys };
if (require.main === module) {
  main().catch(err => {
    const [, kind] = process.argv.slice(2);
    if (['restore', 'capture'].includes(process.argv[2]) && ['client', 'skills'].includes(kind)) {
      try { writeJson(statePath(kind), { ready: false }); } catch { /* Do not write through an unsafe path. */ }
    }
    console.error(`[output-cache] ERROR: ${err.message}`);
    process.exitCode = 1;
  });
}
