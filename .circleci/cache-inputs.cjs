'use strict';

// Semantic build inputs only. Changes to this protocol require CACHE_SCHEMA
// (or the dependency epoch below), not a hash of the CI orchestrator itself.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { builtinModules } = require('module');
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const DEPENDENCY_EPOCH = 1; // Retire snapshots when intentionally refreshing unlocked dependencies.

function collectInputs(root, app) {
  const normalize = file => path.relative(root, file).split(path.sep).join('/');
  const eligible = file => !file.split('/').some(part => /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.git|\.ssh|\.aws|node_modules|dist|dist-electron|release)$/i.test(part))
    && !/\.(?:pem|key|p12|pfx)$/i.test(file);
  function resolveLocal(from, specifier) {
    const target = path.resolve(path.dirname(path.join(root, from)), specifier);
    const candidates = [target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].map(ext => target + ext),
      ...['index.ts', 'index.js', 'index.cjs', 'index.mjs'].map(name => path.join(target, name))];
    if (/\.[cm]?js$/.test(target)) candidates.push(target.replace(/\.[cm]?js$/, '.ts'));
    for (const file of candidates) {
      const relative = normalize(file);
      if (relative.startsWith('../') || !eligible(relative)) throw new Error(`Ineligible local cache input: ${relative}`);
      if (fs.existsSync(file) && fs.lstatSync(file).isFile()) return relative;
    }
    throw new Error(`Unresolved local cache input: ${from} -> ${specifier}`);
  }
  function family(directory) {
    const files = [];
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) return files;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (!eligible(relative)) throw new Error(`Ineligible cache input: ${relative}`);
      if (entry.isDirectory()) files.push(...family(relative));
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Cache source input must be concrete: ${relative}`);
    }
    return files;
  }
  function scriptSeeds(names) {
    const files = new Set();
    const seen = new Set();
    function visit(name) {
      if (seen.has(name)) return;
      seen.add(name);
      for (const hook of [`pre${name}`, name, `post${name}`]) {
        const command = app.scripts[hook] || '';
        for (const match of command.matchAll(/\bnode\s+["']?(scripts\/[\w./-]+\.[cm]?js)\b/g)) files.add(match[1]);
        for (const match of command.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) visit(match[1]);
      }
    }
    names.forEach(visit);
    return [...files];
  }
  function closure(seeds, extraDependencies = []) {
    const files = new Set();
    const dependencies = new Set(extraDependencies);
    function dependency(specifier, from) {
      if (specifier.startsWith('.')) visit(resolveLocal(from, specifier));
      else if (!specifier.startsWith('#') && !builtins.has(specifier.replace(/^node:/, ''))) {
        dependencies.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
      }
    }
    function visit(relative) {
      // package.json is projected below, never hashed wholesale.
      if (relative === 'package.json' || files.has(relative)) return;
      if (!eligible(relative)) throw new Error(`Ineligible cache source input: ${relative}`);
      const file = path.join(root, relative);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Missing/concrete cache input required: ${relative}`);
      files.add(relative);
      if (/(?:^|\/)tsconfig[^/]*\.json$/.test(relative)) {
        const config = ts.readConfigFile(file, name => fs.readFileSync(name, 'utf8'));
        if (config.error) throw new Error(`Cannot parse cache tsconfig input: ${relative}`);
        for (const parent of [config.config.extends || []].flat()) {
          if (parent.startsWith('.')) visit(resolveLocal(relative, parent));
          else throw new Error(`Cache tsconfig extends must be an explicit local input: ${parent}`);
        }
      }
      if (!/\.[cm]?[jt]sx?$/.test(relative)) return;
      const source = ts.createSourceFile(relative, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function walk(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          dependency(node.moduleSpecifier.text, relative);
        } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
          && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require'
            || node.expression.getText(source) === 'require.resolve')) {
          dependency(node.arguments[0].text, relative);
        }
        // Non-import file reads/copies: literal paths based on __dirname or the
        // project root. Dynamic patch/preparer families are explicitly seeded.
        if (ts.isCallExpression(node) && /^(?:path\.)?(?:join|resolve)$/.test(node.expression.getText(source))
          && node.arguments.length > 1 && ['__dirname', 'rootDir', 'projectRoot'].includes(node.arguments[0].getText(source))
          && node.arguments.slice(1).every(arg => ts.isStringLiteralLike(arg))) {
          const base = node.arguments[0].getText(source) === '__dirname' ? path.dirname(file) : root;
          const target = path.resolve(base, ...node.arguments.slice(1).map(arg => arg.text));
          const name = normalize(target);
          if (/^(?:scripts|src|tests|openclaw-extensions)\//.test(name) && eligible(name)
            && fs.existsSync(target) && fs.lstatSync(target).isFile()) visit(name);
        }
        if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL' && node.arguments?.length === 2
          && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[1].getText(source) === 'import.meta.url'
          && node.arguments[0].text.startsWith('.')) {
          const target = path.resolve(path.dirname(file), node.arguments[0].text);
          if (fs.existsSync(target) && fs.lstatSync(target).isFile()) visit(resolveLocal(relative, node.arguments[0].text));
        }
        ts.forEachChild(node, walk);
      }
      walk(source);
    }
    seeds.forEach(visit);
    const declared = {};
    for (const name of [...dependencies].sort()) {
      const version = app.dependencies?.[name] || app.devDependencies?.[name] || app.optionalDependencies?.[name];
      // Upstream #aliases/dependencies are covered by the upstream version and
      // version-scoped patches. Only root-resolved build tools enter this map.
      if (version) declared[name] = version;
    }
    return { files: [...files].sort(), dependencies: declared };
  }
  const core = closure([
    'scripts/ensure-openclaw-version.cjs', 'scripts/apply-openclaw-patches.cjs',
    'scripts/run-build-openclaw-runtime.cjs', 'scripts/build-openclaw-runtime.sh',
    'scripts/ensure-pnpm-native-binary.cjs', 'scripts/pack-openclaw-workspace-deps.cjs',
    'scripts/sync-openclaw-runtime-current.cjs', 'scripts/openclaw-runtime-packaging.cjs',
    'scripts/bundle-openclaw-startup-migration.cjs', 'scripts/bundle-openclaw-gateway.cjs',
    ...family(`scripts/patches/${app.openclaw.version}`),
    // The current app-builder-lib patch only alters installer code, not asar or
    // runtime builds. Conservatively retain other/future root tool patches.
    ...family('patches').filter(file => file !== 'patches/app-builder-lib+24.13.3.patch'),
    ...scriptSeeds(['openclaw:ensure', 'openclaw:patch', 'openclaw:bundle']),
  ], ['electron', 'electron-builder', 'esbuild', 'npm']);
  const plugins = closure(['scripts/ensure-openclaw-plugins.cjs',
    ...family('scripts/openclaw-plugin-preparers'), ...family('scripts/openclaw-plugin-patches'),
    ...scriptSeeds(['openclaw:plugins'])]);
  const extensionFiles = family('openclaw-extensions');
  const full = closure(['scripts/sync-local-openclaw-extensions.cjs', 'scripts/precompile-openclaw-extensions.cjs',
    'scripts/install-openclaw-channel-deps.cjs', 'scripts/prune-openclaw-runtime.cjs',
    'scripts/openclaw-plugin-sdk-contract.cjs', 'scripts/openclaw-plugin-sdk-bridge.cjs', 'tsconfig.json', ...extensionFiles,
    ...scriptSeeds(['openclaw:extensions:local', 'openclaw:precompile', 'openclaw:channel-deps', 'openclaw:prune', 'openclaw:sdk-contract'])]);
  function configuration(inputs, names) {
    const scripts = {};
    for (const name of names) for (const hook of [`pre${name}`, name, `post${name}`]) {
      if (app.scripts[hook]) scripts[hook] = app.scripts[hook];
    }
    return { dependencyEpoch: DEPENDENCY_EPOCH, dependencies: inputs.dependencies, scripts,
      // Only overrides of consumed root dependencies can affect the payload.
      overrides: Object.fromEntries(Object.entries(app.overrides || {}).filter(([name]) => name in inputs.dependencies)) };
  }
  return { core, plugins, full, extensionFiles,
    coreConfig: configuration(core, ['openclaw:ensure', 'openclaw:patch', 'openclaw:bundle']),
    pluginsConfig: configuration(plugins, ['openclaw:plugins']),
    fullConfig: configuration(full, ['openclaw:extensions:local', 'openclaw:precompile', 'openclaw:channel-deps', 'openclaw:prune', 'openclaw:sdk-contract']) };
}

module.exports = { collectInputs };
