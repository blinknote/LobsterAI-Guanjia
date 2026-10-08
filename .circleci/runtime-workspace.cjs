'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const tar = require('tar');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'vendor', 'openclaw-runtime', 'win-x64');
const workspace = path.join(root, '.circleci-workspace');
const archive = path.join(workspace, 'runtime.tar');
const manifestFile = path.join(workspace, 'manifest.json');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const app = readJson(path.join(root, 'package.json'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root, encoding: 'utf8', timeout: 10000,
}).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected full checkout commit.');
const identity = { schemaVersion: 1, commit, appVersion: app.version,
  target: 'win-x64', openclawVersion: app.openclaw.version };

function nonempty(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing/empty required file: ${file}`);
}

function validateRuntime() {
  if (!fs.statSync(path.join(runtime, 'node_modules')).isDirectory()
    || !fs.readdirSync(path.join(runtime, 'node_modules')).length) {
    throw new Error('Runtime dependencies are missing/empty.');
  }
  for (const relative of ['runtime-build-info.json', 'package.json', 'gateway.asar',
    'gateway-bundle.mjs', 'openclaw.mjs', 'dist/control-ui/index.html',
    'third-party-extensions/guanjia-tools/openclaw.plugin.json',
    'third-party-extensions/guanjia-tools/package.json',
    'third-party-extensions/guanjia-tools/index.js']) nonempty(path.join(runtime, relative));
  const info = readJson(path.join(runtime, 'runtime-build-info.json'));
  const host = readJson(path.join(runtime, 'package.json'));
  const plugin = readJson(path.join(runtime, 'third-party-extensions/guanjia-tools/package.json'));
  if (info.target !== identity.target || info.openclawVersion !== identity.openclawVersion
    || !/^[a-f0-9]{40}$/.test(info.openclawCommit || '')
    || host.name !== 'openclaw' || host.version !== identity.openclawVersion.replace(/^v/, '')
    || !plugin.openclaw?.extensions?.includes('./index.js')) {
    throw new Error('Runtime target/version/commit or guanjia-tools compiled entry mismatch.');
  }
  return info.openclawCommit;
}

// Follow only runtime-internal links. Active ancestors detect real cycles;
// revisiting the same directory via another npm dependency link is permitted.
function validateLinks() {
  const base = fs.realpathSync(runtime);
  if (fs.lstatSync(runtime).isSymbolicLink()) throw new Error('Concrete runtime must not be a link.');
  const active = new Set();
  function walk(file) {
    // Reject runtime-root credentials, not files shipped by npm dependencies
    // (for example bottleneck includes a package-owned .env resource).
    if (path.dirname(file) === runtime
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
  walk(runtime);
}

async function sha256() {
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

async function main() {
  if (process.argv[2] === 'export') {
    const openclawCommit = validateRuntime();
    validateLinks();
    fs.mkdirSync(workspace, { recursive: true });
    fs.rmSync(manifestFile, { force: true });
    await tar.create({ file: archive, cwd: runtime, prefix: 'win-x64',
      follow: true, gzip: false, strict: true, portable: true,
      // pnpm may share hard-linked files. Materialize those too: the transfer
      // archive intentionally accepts only regular files and directories.
      filter: (_name, stat) => { stat.nlink = 1; return true; },
    }, fs.readdirSync(runtime));
    nonempty(archive);
    fs.writeFileSync(manifestFile, JSON.stringify({ ...identity, openclawCommit,
      archiveSha256: await sha256() }, null, 2) + '\n');
  } else if (process.argv[2] === 'import') {
    const manifest = readJson(manifestFile);
    for (const [key, value] of Object.entries(identity)) {
      if (manifest[key] !== value) throw new Error(`Workspace manifest mismatch: ${key}`);
    }
    nonempty(archive);
    if (!/^[a-f0-9]{64}$/.test(manifest.archiveSha256 || '')
      || await sha256() !== manifest.archiveSha256) throw new Error('Workspace archive SHA256 mismatch.');
    // Validate the whole archive before writing anything to the fixed destination.
    await tar.list({ file: archive, strict: true, onReadEntry: validateEntry });
    if (fs.existsSync(runtime)) throw new Error('Runtime destination already exists; refusing to overwrite.');
    const parent = path.dirname(runtime);
    fs.mkdirSync(parent, { recursive: true });
    await tar.extract({ file: archive, cwd: parent, strict: true, preservePaths: false,
      filter: (_name, entry) => { validateEntry(entry); return true; } });
    if (validateRuntime() !== manifest.openclawCommit) throw new Error('Workspace OpenClaw commit mismatch.');
    validateLinks();
  } else throw new Error('Usage: runtime-workspace.cjs export|import');
  console.log(`Runtime workspace ${process.argv[2]} verified: ${commit} (${identity.target})`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
