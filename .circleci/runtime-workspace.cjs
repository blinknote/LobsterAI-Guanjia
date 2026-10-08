'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const tar = require('tar');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'vendor', 'openclaw-runtime', 'win-x64');
const workspace = path.join(root, '.circleci-workspace');
const cacheRoot = path.join(root, '.circleci-runtime-cache');
const keysRoot = path.join(root, '.circleci-runtime-keys');
const stateFile = path.join(root, '.circleci-runtime-state.json');
const CACHE_SCHEMA = 2;
// CircleCI caches are immutable. Bump this to retire a corrupt exact-key cache.
const CACHE_EPOCH = 1;
const CORE = 'core';
const FULL = 'full';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const app = readJson(path.join(root, 'package.json'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root, encoding: 'utf8', timeout: 10000,
}).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected full checkout commit.');
const toolchain = { target: 'win-x64', platform: 'windows-server-2022-gui',
  nodeVersion: '24.15.0', npmVersion: '11.17.0', pnpmVersion: '12.1.0',
  electronVersion: app.devDependencies.electron };
if (!/^\d+\.\d+\.\d+$/.test(toolchain.electronVersion)) {
  throw new Error('Compiled runtime caching requires an exact Electron pin.');
}
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
}).split('\0').filter(Boolean).sort();
const packaging = require('../scripts/openclaw-runtime-packaging.cjs');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function sourceFingerprint(config, files) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(stable(config)) + '\0');
  for (const relative of files) {
    // No credentials or generated trees may be read into a source fingerprint.
    if (relative.split('/').some(part => /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.git|\.ssh|\.aws|node_modules|dist|dist-electron|release)$/i.test(part))
      || /\.(?:pem|key|p12|pfx)$/i.test(relative)) {
      throw new Error(`Ineligible compiled-cache source input: ${relative}`);
    }
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Cache source input must be a regular file: ${relative}`);
    const contents = fs.readFileSync(file);
    hash.update(`${relative}\0${contents.length}\0`);
    hash.update(contents);
  }
  return hash.digest('hex');
}

// Conservative core inputs: all tracked build/patch scripts and package
// configuration except the app's name/version. Startup bundling embeds the
// pinned plugin repair metadata, so plugin config is now a core input too.
const coreConfig = { ...app, openclaw: {
  repo: app.openclaw.repo, version: app.openclaw.version, plugins: app.openclaw.plugins,
} };
delete coreConfig.name;
delete coreConfig.version;
const coreFiles = tracked.filter(file => file.startsWith('scripts/') || file.startsWith('patches/')
  || file.startsWith('.circleci/')
  || ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file));
const coreFingerprint = sourceFingerprint({ schemaVersion: CACHE_SCHEMA, epoch: CACHE_EPOCH,
  ...toolchain, package: coreConfig }, coreFiles);
const extensionFiles = tracked.filter(file => file.startsWith('openclaw-extensions/'));
const fullFingerprint = sourceFingerprint({ coreFingerprint, openclaw: app.openclaw }, extensionFiles);

function cacheIdentity(stage) {
  return { schemaVersion: CACHE_SCHEMA, epoch: CACHE_EPOCH, stage,
    fingerprint: stage === CORE ? coreFingerprint : fullFingerprint,
    ...toolchain, openclawVersion: app.openclaw.version, openclawRepo: app.openclaw.repo };
}

function workspaceIdentity(stage = FULL) {
  return { ...cacheIdentity(stage), commit, appVersion: app.version };
}

function payload(dir) {
  return { dir, archive: path.join(dir, 'runtime.tar'), manifestFile: path.join(dir, 'manifest.json') };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readState() {
  const state = readJson(stateFile);
  if (state.commit !== commit || state.coreFingerprint !== coreFingerprint
    || state.fullFingerprint !== fullFingerprint || state.ownsRuntime !== true) {
    throw new Error('Runtime state is not owned by this checkout and these inputs.');
  }
  return state;
}

function nonempty(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing/empty required file: ${file}`);
}

function validateCompiledPlugin(pluginDir, bundled = false, allowSourceEntry = false) {
  for (const file of ['package.json', 'openclaw.plugin.json']) nonempty(path.join(pluginDir, file));
  readJson(path.join(pluginDir, 'openclaw.plugin.json'));
  const pkg = readJson(path.join(pluginDir, 'package.json'));
  const entries = bundled ? pkg.openclaw?.runtimeExtensions : pkg.openclaw?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Plugin has no compiled entry metadata: ${pluginDir}`);
  }
  for (const entry of entries) {
    const extensionPattern = allowSourceEntry ? /\.(?:js|mjs|cjs|ts|mts|cts)$/ : /\.(?:js|mjs|cjs)$/;
    if (typeof entry !== 'string' || !extensionPattern.test(entry)) {
      throw new Error(`Plugin entry is not compiled: ${pluginDir} (${entry})`);
    }
    const relative = path.relative(pluginDir, path.resolve(pluginDir, entry));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe plugin entry: ${entry}`);
    nonempty(path.join(pluginDir, entry));
  }
  return pkg;
}

function validateRuntime(stage, runtimeRoot = runtime) {
  if (!fs.statSync(path.join(runtimeRoot, 'node_modules')).isDirectory()
    || !fs.readdirSync(path.join(runtimeRoot, 'node_modules')).length) {
    throw new Error('Runtime dependencies are missing/empty.');
  }
  for (const relative of ['runtime-build-info.json', 'package.json', 'gateway.asar',
    'dist/control-ui/index.html']) nonempty(path.join(runtimeRoot, relative));
  if (!fs.statSync(path.join(runtimeRoot, 'dist/extensions')).isDirectory()) {
    throw new Error('Runtime bundled extensions directory is missing.');
  }
  const info = readJson(path.join(runtimeRoot, 'runtime-build-info.json'));
  const host = readJson(path.join(runtimeRoot, 'package.json'));
  if (info.target !== toolchain.target || info.openclawVersion !== app.openclaw.version
    || !/^[a-f0-9]{40}$/.test(info.openclawCommit || '')
    || host.name !== 'openclaw' || host.version !== app.openclaw.version.replace(/^v/, '')) {
    throw new Error('Runtime target/version/source commit mismatch.');
  }
  const asar = require('@electron/asar');
  const summary = packaging.summarizeGatewayAsarEntries(asar.listPackage(path.join(runtimeRoot, 'gateway.asar')));
  if (!summary.hasOpenClawEntry || !summary.hasControlUiIndex || !summary.hasGatewayEntry
    || summary.hasBundledExtensions) throw new Error('Runtime gateway.asar layout mismatch.');
  // Sync restores bare entries, then the source-dependent bundle step completes
  // core before transfer. Only plugins and their SDK bridge belong to full.
  for (const file of ['gateway-bundle.mjs', 'openclaw.mjs',
    'openclaw-startup-state-migration.mjs', 'openclaw-xai-auth-store.mjs',
    'openclaw-startup-compat.mjs', 'openclaw-gateway-repair.mjs',
    'lobsterai-repair-plugins.json']) nonempty(path.join(runtimeRoot, file));
  const repairPlugins = readJson(path.join(runtimeRoot, 'lobsterai-repair-plugins.json'));
  if (repairPlugins.openclawVersion !== host.version || !Array.isArray(repairPlugins.plugins)) {
    throw new Error('Runtime bundled plugin repair metadata mismatch.');
  }
  const entry = ['dist/entry.js', 'dist/entry.mjs'].find(file => fs.existsSync(path.join(runtimeRoot, file)));
  if (!entry) throw new Error('Runtime bare gateway entry is missing.');
  nonempty(path.join(runtimeRoot, entry));
  if (stage === FULL) {
    const localPackages = extensionFiles.filter(file => /^openclaw-extensions\/[^/]+\/package\.json$/.test(file));
    if (!localPackages.length) throw new Error('No tracked local extension packages found.');
    for (const file of localPackages) {
      const id = file.split('/')[1];
      const source = readJson(path.join(root, file));
      const plugin = validateCompiledPlugin(path.join(runtimeRoot, 'third-party-extensions', id));
      if (plugin.name !== source.name || plugin.version !== source.version
        || !plugin.openclaw.extensions.includes('./index.js')) {
        throw new Error(`Local compiled plugin metadata mismatch: ${id}`);
      }
    }
    for (const plugin of app.openclaw.plugins || []) {
      if (plugin.optional) continue;
      const pluginDir = packaging.resolvePreinstalledPluginDir(runtimeRoot, plugin);
      // Published provider plugins legitimately use TypeScript entry points;
      // only local precompiled and trusted bundled entries must be JavaScript.
      const pkg = validateCompiledPlugin(pluginDir, plugin.runtimeBundled === true, plugin.runtimeBundled !== true);
      if (pkg.name !== plugin.npm || pkg.version !== plugin.version) {
        throw new Error(`Mandatory published plugin pin mismatch: ${plugin.id}`);
      }
      packaging.verifyRuntimeBundledPlugin(runtimeRoot, plugin);
    }
    require('../scripts/openclaw-plugin-sdk-bridge.cjs').verifyOpenClawPluginSdkBridge(runtimeRoot);
  }
  return info.openclawCommit;
}

// Follow only runtime-internal links. Active ancestors detect real cycles;
// revisiting the same directory via another npm dependency link is permitted.
function validateLinks(runtimeRoot = runtime) {
  const base = fs.realpathSync(runtimeRoot);
  if (fs.lstatSync(runtimeRoot).isSymbolicLink()) throw new Error('Concrete runtime must not be a link.');
  const active = new Set();
  function walk(file) {
    // Reject runtime-root credentials, not files shipped by npm dependencies
    // (for example bottleneck includes a package-owned .env resource).
    if (path.dirname(file) === runtimeRoot
      && /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.git|\.ssh|\.aws)$/i.test(path.basename(file))) {
      throw new Error(`Credential/configuration path cannot enter runtime workspace: ${file}`);
    }
    const real = fs.realpathSync(file);
    const relative = path.relative(base, real);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Runtime link escapes payload: ${file}`);
    }
    const stat = fs.statSync(file);
    if (!stat.isDirectory()) {
      if (!stat.isFile()) throw new Error(`Unsupported runtime entry: ${file}`);
      return;
    }
    if (active.has(real)) throw new Error(`Runtime directory link cycle: ${file}`);
    active.add(real);
    try { for (const name of fs.readdirSync(file)) walk(path.join(file, name)); }
    finally { active.delete(real); }
  }
  walk(runtimeRoot);
}

async function sha256(archive) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  return hash.digest('hex');
}

function validateEntry(entry) {
  const name = entry.path;
  if (name.includes('\\') || path.posix.isAbsolute(name) || /^[a-z]:/i.test(name)
    || name.split('/').some(part => part === '..' || part.includes(':'))
    || !(name === 'win-x64/' || name.startsWith('win-x64/'))
    || !['File', 'Directory'].includes(entry.type)) {
    throw new Error(`Unsafe runtime archive entry: ${name} (${entry.type})`);
  }
}

function assertIdentity(manifest, identity) {
  for (const [key, value] of Object.entries(identity)) {
    if (manifest[key] !== value) throw new Error(`Runtime manifest mismatch: ${key}`);
  }
  for (const key of ['openclawCommit', 'originBuildCommit']) {
    if (!/^[a-f0-9]{40}$/.test(manifest[key] || '')) throw new Error(`Invalid runtime provenance: ${key}`);
  }
}

async function checkArchive(files, identity) {
  const manifest = readJson(files.manifestFile);
  assertIdentity(manifest, identity);
  nonempty(files.archive);
  if (!/^[a-f0-9]{64}$/.test(manifest.archiveSha256 || '')
    || await sha256(files.archive) !== manifest.archiveSha256) throw new Error('Runtime archive SHA256 mismatch.');
  await tar.list({ file: files.archive, strict: true, onReadEntry: validateEntry });
  return manifest;
}

async function exportArchive(files, identity, originBuildCommit = commit) {
  const openclawCommit = validateRuntime(identity.stage);
  validateLinks();
  fs.mkdirSync(files.dir, { recursive: true });
  fs.rmSync(files.manifestFile, { force: true });
  await tar.create({ file: files.archive, cwd: runtime, prefix: 'win-x64',
      follow: true, gzip: false, strict: true, portable: true,
      // pnpm may share hard-linked files. Materialize those too: the transfer
      // archive intentionally accepts only regular files and directories.
      filter: (_name, stat) => { stat.nlink = 1; return true; },
  }, fs.readdirSync(runtime));
  nonempty(files.archive);
  await tar.list({ file: files.archive, strict: true, onReadEntry: validateEntry });
  writeJson(files.manifestFile, { ...identity, openclawCommit, originBuildCommit,
    archiveSha256: await sha256(files.archive) });
}

async function importArchive(files, identity, replaceOwnedCore = false) {
  const manifest = await checkArchive(files, identity);
  const parent = path.dirname(runtime);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.circleci-runtime-restore-'));
  try {
    await tar.extract({ file: files.archive, cwd: staging, strict: true, preservePaths: false,
      filter: (_name, entry) => { validateEntry(entry); return true; } });
    const extracted = path.join(staging, 'win-x64');
    validateLinks(extracted);
    if (validateRuntime(identity.stage, extracted) !== manifest.openclawCommit) {
      throw new Error('Runtime OpenClaw source commit mismatch.');
    }
    if (replaceOwnedCore) {
      const state = readState();
      if (!state.coreReady || state.stage !== CORE) throw new Error('Only this job\'s verified core can be replaced.');
      validateLinks();
      validateRuntime(CORE);
      fs.rmSync(runtime, { recursive: true });
    } else if (fs.existsSync(runtime)) {
      throw new Error('Runtime destination already exists; refusing to overwrite.');
    }
    fs.renameSync(extracted, runtime);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return manifest;
}

function cachePresent(stage) {
  const files = payload(path.join(cacheRoot, stage));
  if (!fs.existsSync(files.dir)) return false;
  if (!fs.existsSync(files.archive) || !fs.existsSync(files.manifestFile)) {
    throw new Error(`Incomplete ${stage} compiled cache.`);
  }
  return true;
}

async function main() {
  const action = process.argv[2];
  if (action === 'fingerprints') {
    console.log(JSON.stringify({ core: cacheIdentity(CORE), full: cacheIdentity(FULL) }, null, 2));
    return;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== toolchain.nodeVersion) {
    throw new Error('Runtime transfer requires Windows x64 with pinned Node 24.15.0.');
  }
  if (action === 'cache-keys') {
    if (fs.existsSync(runtime) || fs.existsSync(stateFile) || fs.existsSync(cacheRoot)) {
      throw new Error('Compiled-cache setup requires a fresh job; refusing to reuse unowned output.');
    }
    fs.mkdirSync(keysRoot, { recursive: true });
    for (const stage of [CORE, FULL]) writeJson(path.join(keysRoot, `${stage}.txt`), cacheIdentity(stage));
  } else if (action === 'prepare-core') {
    if (fs.existsSync(runtime) || fs.existsSync(stateFile)) throw new Error('Core destination/state already exists; refusing to overwrite.');
    const hit = cachePresent(CORE);
    const manifest = hit ? await importArchive(payload(path.join(cacheRoot, CORE)), cacheIdentity(CORE)) : null;
    writeJson(stateFile, { commit, coreFingerprint, fullFingerprint, ownsRuntime: true,
      coreReady: hit, fullReady: false, stage: CORE, originBuildCommit: manifest?.originBuildCommit || commit });
    console.log(hit ? 'Verified core compiled cache hit; skip core build.'
      : fs.existsSync(path.join(cacheRoot, FULL))
        ? 'Full cache present but core missing; rebuild a legitimate core before saving (never relabel full).'
        : 'Core compiled cache miss; build core.');
  } else if (action === 'capture-core') {
    const state = readState();
    if (state.stage !== CORE) throw new Error('Cannot label a full runtime as core.');
    if (!state.coreReady) await exportArchive(payload(path.join(cacheRoot, CORE)), cacheIdentity(CORE));
    else { validateLinks(); validateRuntime(CORE); }
    writeJson(stateFile, { ...state, coreReady: true });
  } else if (action === 'prepare-full') {
    const state = readState();
    if (!state.coreReady || state.stage !== CORE) throw new Error('Save a verified core before preparing full runtime.');
    const hit = cachePresent(FULL);
    const manifest = hit ? await importArchive(payload(path.join(cacheRoot, FULL)), cacheIdentity(FULL), true) : null;
    writeJson(stateFile, { ...state, fullReady: hit, stage: hit ? FULL : CORE,
      originBuildCommit: manifest?.originBuildCommit || commit });
    console.log(hit ? 'Verified full compiled cache hit; skip build remainder.' : 'Full compiled cache miss; build remainder only.');
  } else if (action === 'capture-full') {
    const state = readState();
    if (!state.coreReady) throw new Error('Full snapshot requires verified core.');
    if (!state.fullReady) await exportArchive(payload(path.join(cacheRoot, FULL)), cacheIdentity(FULL));
    else { validateLinks(); validateRuntime(FULL); }
    writeJson(stateFile, { ...state, fullReady: true, stage: FULL });
  } else if (action === 'export-core') {
    const state = readState();
    if (!state.coreReady || state.stage !== CORE) throw new Error('Core workspace export requires verified core inputs.');
    // Reuse the captured, identity/SHA/entry-verified core; never repack or
    // relabel a full snapshot. Only the workspace attestation binds this HEAD.
    const snapshot = payload(path.join(cacheRoot, CORE));
    const manifest = await checkArchive(snapshot, cacheIdentity(CORE));
    const files = payload(path.join(workspace, CORE));
    fs.mkdirSync(files.dir, { recursive: true });
    fs.rmSync(files.manifestFile, { force: true });
    fs.copyFileSync(snapshot.archive, files.archive);
    writeJson(files.manifestFile, { ...manifest, ...workspaceIdentity(CORE) });
  } else if (action === 'import-core') {
    if (fs.existsSync(runtime) || fs.existsSync(stateFile)) throw new Error('Core workspace import requires a fresh runtime and state.');
    const manifest = await importArchive(payload(path.join(workspace, CORE)), workspaceIdentity(CORE));
    writeJson(stateFile, { commit, coreFingerprint, fullFingerprint, ownsRuntime: true,
      coreReady: true, fullReady: false, stage: CORE, originBuildCommit: manifest.originBuildCommit });
  } else if (action === 'export') {
    const state = readState();
    if (!state.fullReady || state.stage !== FULL) throw new Error('Workspace export requires validated full inputs.');
    await exportArchive(payload(path.join(workspace, FULL)), workspaceIdentity(), state.originBuildCommit);
  } else if (action === 'import') {
    await importArchive(payload(path.join(workspace, FULL)), workspaceIdentity());
  } else throw new Error('Usage: runtime-workspace.cjs fingerprints|cache-keys|prepare-core|capture-core|prepare-full|capture-full|export-core|import-core|export|import');
  console.log(`Runtime ${action} verified: ${commit} (${toolchain.target})`);
}

main().catch(error => {
  console.error(error.stack || error);
  if (['prepare-core', 'prepare-full'].includes(process.argv[2])) {
    console.error('Compiled cache rejected; no fallback. Inspect the error and bump CACHE_EPOCH in .circleci/runtime-workspace.cjs to retire immutable corrupt caches.');
  }
  process.exitCode = 1;
});
