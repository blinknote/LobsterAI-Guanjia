'use strict';

// Bootstrap-only: no dependency on node_modules and no install/lock regeneration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SCHEMA = 1;
const DEPENDENCY_EPOCH = 1; // Bump to intentionally refresh unlocked resolutions.
const TARGET = { image: 'windows-server-2022', platform: 'win32', arch: 'x64',
  node: '24.15.0', npm: '11.17.0', pnpm: '12.1.0', electron: '43.5.0' };
const MANIFEST = '.circleci-dependency-cache/manifest.json';
const STATE = '.circleci-dependency-state.json';
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const FIELDS = ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies',
  'peerDependencies', 'peerDependenciesMeta', 'overrides', 'engines', 'os', 'cpu', 'packageManager', 'workspaces',
  'allowScripts', 'config'];

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const absolute = relative => path.join(ROOT, relative);
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) {
  if (error.code === 'ENOENT') return false;
  throw error;
} };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const inside = (root, file) => { const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };

function hashFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Cache file must be a concrete regular file');
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}

// Hash every file, manifest, native binary and link, without following links.
// Internal links are accepted only when their final target remains in this tree.
async function treeDigest(directory) {
  const base = path.resolve(directory);
  if (!fs.lstatSync(base).isDirectory() || fs.lstatSync(base).isSymbolicLink()) {
    throw new Error('Cache tree must be a concrete directory');
  }
  const realBase = fs.realpathSync(base);
  const digest = crypto.createHash('sha256');
  async function visit(file, relative) {
    const stat = fs.lstatSync(file);
    const name = relative.split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file);
      const target = path.resolve(path.dirname(file), link);
      if (!inside(base, target) || !inside(realBase, fs.realpathSync(file))) throw new Error('Cache link escapes tree');
      // Windows pnpm junctions may be absolute but must remain inside this tree.
      const normalized = path.isAbsolute(link) ? path.relative(base, target) : link;
      digest.update(stable(['link', name, normalized.split(path.sep).join('/')]) + '\n');
    } else if (stat.isDirectory()) {
      digest.update(stable(['directory', name]) + '\n');
      for (const entry of fs.readdirSync(file).sort()) await visit(path.join(file, entry), path.join(relative, entry));
    } else if (stat.isFile()) {
      digest.update(stable(['file', name, stat.size, hashFile(file)]) + '\n');
    } else throw new Error('Cache tree contains a special file');
  }
  await visit(base, '');
  return digest.digest('hex');
}

function sourceFiles(directory, exclude = new Set()) {
  const result = {};
  if (!exists(absolute(directory))) return result;
  function visit(relative) {
    const stat = fs.lstatSync(absolute(relative));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute(relative)).sort()) {
        if (!exclude.has(name)) visit(`${relative}/${name}`);
      }
    } else result[relative] = hashFile(absolute(relative));
  }
  visit(directory);
  return result;
}

function fingerprint() {
  const app = readJson(absolute('package.json'));
  const semantic = Object.fromEntries(FIELDS.filter(field => app[field] !== undefined).map(field => [field, app[field]]));
  const scripts = {};
  const files = { ...sourceFiles('patches'), ...sourceFiles('.husky', new Set(['_'])) };
  const seen = new Set();
  function script(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const command = app.scripts?.[name];
    if (!command) return;
    scripts[name] = command;
    for (const match of command.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) {
      for (const hook of [`pre${match[1]}`, match[1], `post${match[1]}`]) script(hook);
    }
    for (const match of command.matchAll(/\bnode\s+["']?([\w./-]+\.[cm]?js)\b/g)) local(match[1]);
  }
  function local(relative) {
    const file = path.resolve(ROOT, relative);
    if (!inside(ROOT, file)) throw new Error('Install hook source escapes repository');
    relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (files[relative]) return;
    files[relative] = hashFile(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\brequire(?:\.resolve)?\(['"](\.[^'"]+)['"]\)/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const resolved = [target, ...['.cjs', '.js', '.json', '/index.cjs', '/index.js'].map(ext => target + ext)]
        .find(candidate => exists(candidate) && fs.lstatSync(candidate).isFile());
      if (!resolved) throw new Error('Unresolved install hook source');
      local(path.relative(ROOT, resolved));
    }
  }
  LIFECYCLE.forEach(script);
  for (const version of Object.values({ ...app.dependencies, ...app.devDependencies, ...app.optionalDependencies })) {
    if (/^(?:file:|link:|workspace:)/.test(version)) throw new Error('Local dependencies require an explicit cache protocol update');
  }
  const identity = { schema: SCHEMA, dependencyEpoch: DEPENDENCY_EPOCH, target: TARGET,
    semantic, scripts, files, npmrcSha256: exists(absolute('.npmrc')) ? hashFile(absolute('.npmrc')) : null,
    install: { command: 'npm install', includeDev: true, lifecycle: true, nativePhase: 'npm-install-pre-package' } };
  return { identity, key: hash(stable(identity)) };
}

function checkToolchain() {
  if (process.platform !== TARGET.platform || process.arch !== TARGET.arch || process.versions.node !== TARGET.node) {
    throw new Error('Dependency snapshots require Windows x64 and the exact pinned Node version');
  }
  for (const name of ['npm', 'pnpm']) {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${name}.cmd --version`],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (result.error || result.status !== 0 || result.stdout.trim() !== TARGET[name]) {
      throw new Error(`Dependency snapshots require the exact pinned ${name} version`);
    }
  }
}

function rejectCredentials(lock) {
  // Package fixture .env files are legitimate; only cache-root credentials are forbidden.
  for (const name of fs.readdirSync(absolute('node_modules'))) {
    if (/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|credentials(?:\..*)?)$/i.test(name)
      || /\.(?:pem|key|p12|pfx)$/i.test(name)) throw new Error('Top-level credential material cannot be cached');
  }
  for (const entry of Object.values(lock.packages || {})) {
    if (!entry.resolved) continue;
    try { const url = new URL(entry.resolved);
      if (url.username || url.password || /(?:token|auth|password|secret|signature|credential)=/i.test(url.search)) {
        throw new Error('Lock contains credential-bearing resolution');
      }
    } catch (error) { if (error.message === 'Lock contains credential-bearing resolution') throw error; }
  }
}

function inspectInstalled() {
  const app = readJson(absolute('package.json'));
  const lock = readJson(absolute('package-lock.json'));
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('Missing producing npm v3 lock');
  const root = lock.packages[''];
  for (const field of ['name', 'version']) {
    if ((root[field] ?? lock[field]) !== app[field]) throw new Error('Producing lock metadata mismatch');
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'engines']) {
    if (stable(root[field] || {}) !== stable(app[field] || {})) throw new Error('Producing lock is incompatible with root package');
  }
  if (lock.name !== app.name || lock.version !== app.version) throw new Error('Producing lock metadata mismatch');
  rejectCredentials(lock);
  const required = { ...app.dependencies, ...app.devDependencies };
  for (const name of Object.keys(app.optionalDependencies || {})) delete required[name];
  for (const name of Object.keys(required)) {
    if (name.startsWith('.') || name.includes('..') || path.isAbsolute(name)) throw new Error('Invalid root dependency name');
    const relative = `node_modules/${name}`;
    const installed = readJson(absolute(`${relative}/package.json`));
    if (!installed.version || installed.version !== lock.packages[relative]?.version) {
      throw new Error('Incomplete or production-only dependency tree');
    }
  }
  for (const tool of ['tsc', 'vite', 'electron-builder', 'patch-package', 'husky']) {
    if (!exists(absolute(`node_modules/.bin/${tool}.cmd`))) throw new Error('Installed build tool is missing');
  }
  const electron = readJson(absolute('node_modules/electron/package.json'));
  if (electron.version !== TARGET.electron) {
    throw new Error('Installed Electron is incomplete or has the wrong version');
  }
  if (exists(absolute('node_modules/electron/dist/version'))
    && fs.readFileSync(absolute('node_modules/electron/dist/version'), 'utf8').trim() !== TARGET.electron) {
    throw new Error('Installed Electron binary has the wrong version');
  }
  if (exists(absolute('node_modules/electron/path.txt'))
    && fs.readFileSync(absolute('node_modules/electron/path.txt'), 'utf8').trim() !== 'electron.exe') {
    throw new Error('Installed Electron path is not electron.exe');
  }
  const natives = {};
  function pe(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(64); const signature = Buffer.alloc(6);
      if (fs.readSync(fd, head, 0, head.length, 0) !== 64 || head.toString('ascii', 0, 2) !== 'MZ'
        || fs.readSync(fd, signature, 0, 6, head.readUInt32LE(60)) !== 6
        || signature.readUInt32LE(0) !== 0x4550 || signature.readUInt16LE(4) !== 0x8664) {
        throw new Error('Installed native binary is not Windows PE x64');
      }
    } finally { fs.closeSync(fd); }
  }
  const checkBinaries = ['node_modules/better-sqlite3/prebuilds/win32-x64.node'];
  if (exists(absolute('node_modules/electron/dist/electron.exe'))) {
    checkBinaries.push('node_modules/electron/dist/electron.exe');
  }
  for (const binary of checkBinaries) {
    pe(absolute(binary)); natives[binary] = hashFile(absolute(binary));
  }
  function scan(relative) {
    for (const entry of fs.readdirSync(absolute(relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) scan(child);
      // Packages legitimately bundle other platforms' prebuilds. Check only the
      // selected Windows x64 prebuilds; the full digest covers every binary.
      else if (entry.isFile() && entry.name.endsWith('.node') && child.includes('/prebuilds/win32-x64/')) {
        pe(absolute(child)); natives[child] = hashFile(absolute(child));
      }
    }
  }
  scan('node_modules');
  const hidden = absolute('node_modules/.package-lock.json');
  // npm can omit its hidden lock. Preserve that fact, never manufacture one.
  if (exists(hidden)) {
    const hiddenLock = readJson(hidden);
    if (hiddenLock.lockfileVersion !== 3 || !hiddenLock.packages) throw new Error('Invalid hidden npm lock');
    rejectCredentials(hiddenLock);
    for (const name of Object.keys(required)) {
      if (hiddenLock.packages[`node_modules/${name}`]?.version !== lock.packages[`node_modules/${name}`]?.version) {
        throw new Error('Hidden npm lock does not match installed root dependencies');
      }
    }
  }
  return { rootLockSha256: hashFile(absolute('package-lock.json')),
    hiddenLockSha256: exists(hidden) ? hashFile(hidden) : null, natives,
    nativePhase: 'npm-install-pre-package' };
}

// Every owned path has a fixed relative name. Reject redirected ancestors before
// reading/writing/removing anything; treeDigest also checks internal links.
function safePath(relative) {
  const normalized = path.isAbsolute(relative) ? path.relative(ROOT, relative).split(path.sep).join('/') : relative;
  const parts = normalized.split('/');
  let current = ROOT;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (!exists(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error(`Dependency cache path is redirected: ${relative}`);
    }
  }
  return current;
}

function writeJson(relative, value) {
  const file = safePath(relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

async function main(command, args) {
  if (!['fingerprint', 'keys', 'restore', 'capture'].includes(command)
    || (command === 'capture' ? args.join(' ') !== '--install-succeeded' : args.length !== 0)) {
    throw new Error('Usage: dependency-cache.cjs fingerprint|keys|restore|capture --install-succeeded');
  }
  const current = fingerprint();
  if (command === 'fingerprint') { console.log(JSON.stringify(current, null, 2)); return; }
  checkToolchain();
  if (command === 'keys') {
    const file = safePath('.circleci-dependency-keys/root.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, current.key + '\n');
    console.log('[DependencyCache] Exact root key generated'); return;
  }
  writeJson(STATE, { ready: false });
  if (command === 'restore') {
    const marker = exists(safePath(MANIFEST));
    const tree = exists(absolute('node_modules'));
    const lock = exists(absolute('package-lock.json'));
    if (!marker && !tree && !lock) { console.log('[DependencyCache] Miss'); return; }
    if (!marker || !tree || !lock) throw new Error('Partial dependency cache; refusing install fallback');
    if (!fs.lstatSync(safePath(MANIFEST)).isFile()) throw new Error('Dependency marker must be a concrete file');
    const saved = readJson(safePath(MANIFEST));
    if (saved.schema !== SCHEMA || saved.key !== current.key || stable(saved.identity) !== stable(current.identity)
      || saved.successfulInstall !== true || saved.nativePhase !== 'npm-install-pre-package') {
      throw new Error('Dependency cache identity mismatch');
    }
    if (stable(inspectInstalled()) !== stable(saved.installed)
      || await treeDigest(absolute('node_modules')) !== saved.treeSha256) throw new Error('Dependency cache integrity mismatch');
    // prepare/husky is a checkout side effect, not required for production reuse.
    // Never rerun lifecycle scripts or native rebuilding on a validated hit.
    writeJson(STATE, { ready: true }); console.log('[DependencyCache] Verified installed tree; skipping npm install'); return;
  }
  const installed = inspectInstalled();
  const treeSha256 = await treeDigest(absolute('node_modules'));
  writeJson(MANIFEST, { schema: SCHEMA, ...current, successfulInstall: true,
    nativePhase: 'npm-install-pre-package', installed, treeSha256 });
  writeJson(STATE, { ready: true });
  console.log('[DependencyCache] Captured successful install before packaging');
}

module.exports = { stable, hashFile, treeDigest };
if (require.main === module) main(process.argv[2], process.argv.slice(3)).catch(error => {
  if (['restore', 'capture'].includes(process.argv[2])) {
    try { writeJson(STATE, { ready: false }); } catch { /* Do not write through an unsafe path. */ }
  }
  console.error(`[DependencyCache] ${error.message}`); process.exitCode = 1;
});
