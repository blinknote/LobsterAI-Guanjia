'use strict';

// Cache verification only. The caller must run the original setup successfully
// before capture; this helper never downloads, extracts, or executes a runtime.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { stable, hashFile, treeDigest } = require('./dependency-cache.cjs');
const ROOT = path.resolve(__dirname, '..');
const SCHEMA = 1;
// Exact CircleCI keys are immutable. Bump to retire/refresh an existing payload.
const RESOURCE_EPOCH = 1;
const TARGET = { image: 'windows-server-2022', platform: 'win32', arch: 'x64',
  node: '24.15.0', npm: '11.17.0', pnpm: '12.1.0', electron: '43.5.0' };
const RESOURCES = {
  python: { directory: 'resources/python-win', archive: 'resources/python-win-runtime.zip',
    script: 'scripts/setup-python-runtime.js', command: 'setup:python-runtime', dependency: 'extract-zip',
    defaults: { version: '3.11.9', archiveUrl: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
      getPipUrl: 'https://bootstrap.pypa.io/get-pip.py', pipPyzUrl: 'https://bootstrap.pypa.io/pip/pip.pyz' },
    overrides: ['LOBSTERAI_PORTABLE_PYTHON_ARCHIVE', 'LOBSTERAI_PORTABLE_PYTHON_URL',
      'LOBSTERAI_WINDOWS_EMBED_PYTHON_VERSION', 'LOBSTERAI_WINDOWS_EMBED_PYTHON_URL',
      'LOBSTERAI_WINDOWS_GET_PIP_URL', 'LOBSTERAI_WINDOWS_PIP_PYZ_URL', 'LOBSTERAI_SETUP_PYTHON_RUNTIME_FORCE'] },
  portablegit: { directory: 'resources/mingit', archive: 'resources/PortableGit-2.47.1-64-bit.7z.exe',
    script: 'scripts/setup-mingit.js', command: 'setup:mingit', dependency: '7zip-bin',
    defaults: { version: '2.47.1', archiveUrl: 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/PortableGit-2.47.1-64-bit.7z.exe' },
    overrides: ['LOBSTERAI_PORTABLE_GIT_ARCHIVE', 'LOBSTERAI_PORTABLE_GIT_URL', 'LOBSTERAI_SETUP_MINGIT_FORCE'] },
};
const absolute = relative => path.join(ROOT, relative);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) {
  if (error.code === 'ENOENT') return false;
  throw error;
} };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const manifestPath = kind => `.circleci-resource-cache/${kind}.json`;
const statePath = kind => `.circleci-resource-state-${kind}.json`;

// Every owned path has a fixed relative name. Reject redirected ancestors before
// reading/writing/removing anything; treeDigest also checks internal links.
function safePath(relative) {
  const parts = relative.split('/');
  let current = ROOT;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (!exists(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error(`Resource cache path is redirected: ${relative}`);
    }
  }
  return current;
}

function writeJson(relative, value) {
  const file = safePath(relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function rejectOverrides(kind) {
  for (const name of RESOURCES[kind].overrides) {
    if (process.env[name]) throw new Error(`Resource reuse requires default sources/policy; unset ${name}.`);
  }
}

function checkToolchain() {
  if (process.platform !== TARGET.platform || process.arch !== TARGET.arch || process.versions.node !== TARGET.node) {
    throw new Error('Resource caches require Windows x64 and Node 24.15.0. Use fingerprints for local diagnostics.');
  }
  const app = readJson(safePath('package.json'));
  if (app.devDependencies?.electron !== TARGET.electron) throw new Error('Resource cache Electron pin does not match.');
}

function fingerprint(kind) {
  const resource = RESOURCES[kind];
  const app = readJson(safePath('package.json'));
  const scripts = Object.fromEntries([`pre${resource.command}`, resource.command, `post${resource.command}`]
    .filter(name => app.scripts?.[name]).map(name => [name, app.scripts[name]]));
  // The producing npm v3 lock and installed package metadata supply actual
  // extractor versions/integrity, not a fabricated checksum of a live URL.
  const lock = readJson(safePath('package-lock.json'));
  const packagePath = `node_modules/${resource.dependency}/package.json`;
  const installed = readJson(safePath(packagePath));
  const locked = lock.packages?.[`node_modules/${resource.dependency}`];
  if (lock.lockfileVersion !== 3 || !locked || installed.version !== locked.version) {
    throw new Error(`Resource cache requires producing lock/installed ${resource.dependency} agreement.`);
  }
  const identity = { schema: SCHEMA, epoch: RESOURCE_EPOCH, kind, target: TARGET,
    defaults: resource.defaults, directory: resource.directory, archive: resource.archive, scripts,
    scriptSha256: hashFile(safePath(resource.script)),
    helperSha256: hashFile(safePath('.circleci/resource-cache.cjs')),
    hashImplementationSha256: hashFile(safePath('.circleci/dependency-cache.cjs')),
    dependency: { name: resource.dependency,
      declared: app.dependencies?.[resource.dependency] || app.devDependencies?.[resource.dependency],
      version: installed.version, packageSha256: hashFile(safePath(packagePath)),
      resolutionSha256: hash(locked), overrides: app.overrides || {} } };
  return { identity, fingerprint: hash(identity) };
}

function nonempty(relative) {
  const file = safePath(relative);
  return exists(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
}

function preparedHealth(kind) {
  const directory = RESOURCES[kind].directory;
  if (kind === 'python') {
    const pipCommands = ['pip.exe', 'pip3.exe', 'pip.cmd', 'pip3.cmd', 'pip', 'pip3'];
    if (!nonempty(`${directory}/python.exe`) || !nonempty(`${directory}/python3.exe`)
      || !pipCommands.some(name => nonempty(`${directory}/Scripts/${name}`))
      || !['__main__.py', '__init__.py'].some(name => exists(safePath(`${directory}/Lib/site-packages/pip/${name}`)))) {
      throw new Error('Python resource is not prepared (interpreter/alias/pip missing).');
    }
  } else {
    if (!['bin/bash.exe', 'usr/bin/bash.exe'].some(name => nonempty(`${directory}/${name}`))) {
      throw new Error('PortableGit resource is not prepared (bash.exe missing).');
    }
    for (const name of ['dev/shm', 'dev/mqueue']) {
      const file = safePath(`${directory}/${name}`);
      if (!exists(file) || !fs.lstatSync(file).isDirectory()) throw new Error(`PortableGit runtime directory missing: ${name}`);
    }
  }
}

function pythonMetadata(directory) {
  const site = safePath(`${directory}/Lib/site-packages`);
  const distributions = [];
  if (exists(site)) for (const name of fs.readdirSync(site).sort()) {
    if (!/^pip-[^/]+\.dist-info$/.test(name)) continue;
    const relative = `${directory}/Lib/site-packages/${name}/METADATA`;
    if (!exists(safePath(relative))) continue;
    const raw = fs.readFileSync(safePath(relative), 'utf8');
    distributions.push({ name: raw.match(/^Name:\s*(.+)$/m)?.[1]?.trim() || null,
      version: raw.match(/^Version:\s*(.+)$/m)?.[1]?.trim() || null, metadataSha256: hashFile(safePath(relative)) });
  }
  const init = `${directory}/Lib/site-packages/pip/__init__.py`;
  const pipVersion = exists(safePath(init))
    ? fs.readFileSync(safePath(init), 'utf8').match(/^__version__\s*=\s*['"]([^'"]+)['"]/m)?.[1] || null : null;
  const pyz = `${directory}/tools/pip.pyz`;
  return { method: 'local-files-only', pipVersion, distributions,
    pipPyzSha256: exists(safePath(pyz)) ? hashFile(safePath(pyz)) : null,
    runtimeLibraryNames: fs.readdirSync(safePath(directory)).filter(name => /^python\d+\.(dll|zip)$/.test(name)).sort() };
}

// Only the original setup's explicitly owned convergence files may change on a
// hit. All other payload bytes retain a separate digest across that setup call.
async function protectedDigest(kind) {
  const directory = RESOURCES[kind].directory;
  const excluded = kind === 'python' ? ['Scripts/pip.cmd', 'Scripts/pip3.cmd', 'Scripts/pip', 'Scripts/pip3',
    'Lib/site-packages/pip/__main__.py', 'Lib/site-packages/pip/__init__.py'] : [];
  async function visit(relative) {
    if (excluded.includes(relative)) return null;
    const file = safePath(`${directory}${relative ? '/' + relative : ''}`);
    const stat = fs.lstatSync(file);
    if (!excluded.some(name => !relative || name.startsWith(relative + '/'))) {
      return stat.isDirectory() ? treeDigest(file) : hashFile(file);
    }
    if (!stat.isDirectory()) throw new Error('Convergence path ancestor must be a directory.');
    const entries = [];
    for (const name of fs.readdirSync(file).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const digest = await visit(child);
      if (digest !== null) entries.push([name, digest]);
    }
    return hash(entries);
  }
  return visit('');
}

async function payload(kind) {
  const resource = RESOURCES[kind];
  const directory = safePath(resource.directory);
  const digest = await treeDigest(directory);
  preparedHealth(kind);
  const archive = safePath(resource.archive);
  const archiveSha256 = exists(archive) ? hashFile(archive) : null;
  const metadata = kind === 'python' ? pythonMetadata(resource.directory)
    : { method: 'local-files-only', versionDeclaration: resource.defaults.version,
      versionVerifiedByExecution: false };
  return { treeSha256: digest, protectedSha256: await protectedDigest(kind), archiveSha256, metadata };
}

function rejectUnownedPayload(kind) {
  for (const relative of [RESOURCES[kind].directory, RESOURCES[kind].archive]) {
    const file = safePath(relative);
    if (exists(file)) throw new Error(`${kind} resource exists without a cache manifest; refusing unowned payload: ${relative}`);
  }
}

async function restore(kind, current) {
  writeJson(statePath(kind), { ready: false, fingerprint: current.fingerprint });
  const file = safePath(manifestPath(kind));
  if (!exists(file)) {
    // A default setup accepts existing prepared files. Without provenance they
    // must not silently become a successful cold cache capture.
    rejectUnownedPayload(kind);
    console.log(`[resource-cache] ${kind}: cold miss; original setup required.`);
    return;
  }
  const manifest = readJson(file);
  if (manifest.fingerprint !== current.fingerprint || stable(manifest.identity) !== stable(current.identity)) {
    throw new Error(`${kind} resource cache identity mismatch; bump RESOURCE_EPOCH to retire an immutable cache.`);
  }
  const actual = await payload(kind);
  if (stable(actual) !== stable(manifest.payload)) throw new Error(`${kind} resource cache integrity mismatch.`);
  writeJson(statePath(kind), { ready: true, fingerprint: current.fingerprint, restored: true, payload: actual });
  console.log(`[resource-cache] ${kind}: verified hit; original setup health/convergence still required.`);
}

async function capture(kind, current) {
  const state = safePath(statePath(kind));
  const previous = exists(state) ? readJson(state) : null;
  writeJson(statePath(kind), { ready: false, fingerprint: current.fingerprint });
  const actual = await payload(kind);
  const changedAfterSetup = previous?.restored === true && previous.fingerprint === current.fingerprint
    && stable(previous.payload) !== stable(actual);
  if (changedAfterSetup && (previous.payload.protectedSha256 !== actual.protectedSha256
    || previous.payload.archiveSha256 !== actual.archiveSha256)) {
    throw new Error(`${kind} setup changed content outside owned convergence files; refusing capture under the restored immutable key.`);
  }
  writeJson(manifestPath(kind), { ...current, payload: actual, capturedAt: new Date().toISOString() });
  writeJson(statePath(kind), { ready: true, fingerprint: current.fingerprint, changedAfterSetup });
  if (changedAfterSetup) console.log(`[resource-cache] ${kind}: setup changed content; manifest refreshed under the SAME key. Existing immutable cache is not relabeled/replaced.`);
  else console.log(`[resource-cache] ${kind}: successful setup captured.`);
}

async function main() {
  const [action, kind, ...extra] = process.argv.slice(2);
  if (!['keys', 'restore', 'capture', 'fingerprints'].includes(action) || extra.length
    || (kind && !RESOURCES[kind]) || (!kind && ['restore', 'capture'].includes(action))) {
    throw new Error('Usage: resource-cache.cjs keys|fingerprints [python|portablegit], or restore|capture <kind>');
  }
  const kinds = kind ? [kind] : Object.keys(RESOURCES);
  // Policy rejection precedes any resource or marker write, including keys.
  kinds.forEach(rejectOverrides);
  if (action !== 'fingerprints') checkToolchain();
  for (const selected of kinds) {
    const current = fingerprint(selected);
    if (action === 'fingerprints') console.log(JSON.stringify(current, null, 2));
    else if (action === 'keys') {
      const file = safePath(`.circleci-resource-keys/${selected}.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, current.fingerprint + '\n');
      console.log(`[resource-cache] ${selected}: ${current.fingerprint}`);
    } else if (action === 'restore') await restore(selected, current);
    else await capture(selected, current);
  }
}

if (require.main === module) main().catch(error => {
  const [action, kind] = process.argv.slice(2);
  if (['restore', 'capture'].includes(action) && RESOURCES[kind]) {
    try { writeJson(statePath(kind), { ready: false }); } catch { /* Do not write through an unsafe path. */ }
  }
  console.error('[resource-cache] ERROR:', error.message);
  process.exitCode = 1;
});
