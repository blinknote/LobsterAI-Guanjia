'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));

// 1. 插件指纹：仅取决于 openclaw.plugins 列表及各插件版本，完全与项目自身的 version/scripts 解耦
const pluginsDigest = crypto
  .createHash('sha256')
  .update(JSON.stringify(pkg.openclaw?.plugins || []))
  .digest('hex');
fs.writeFileSync(path.join(rootDir, '.openclaw-plugins-hash'), pluginsDigest);

// 2. 运行时指纹：仅取决于 openclaw 自身版本、repo 配置，不随主客户端 version 变动
const runtimeDigest = crypto
  .createHash('sha256')
  .update(JSON.stringify({
    version: pkg.openclaw?.version,
    repo: pkg.openclaw?.repo,
  }))
  .digest('hex');
fs.writeFileSync(path.join(rootDir, '.openclaw-runtime-hash'), runtimeDigest);

// 3. 依赖指纹：仅取决于 dependencies / devDependencies / optionalDependencies，排除客户端版本号干扰
const depsDigest = crypto
  .createHash('sha256')
  .update(JSON.stringify({
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
    optionalDependencies: pkg.optionalDependencies || {},
  }))
  .digest('hex');
fs.writeFileSync(path.join(rootDir, '.dependencies-hash'), depsDigest);

console.log(`[CacheKeys] Generated fingerprints:`);
console.log(`  - openclaw-plugins: ${pluginsDigest.slice(0, 16)}...`);
console.log(`  - openclaw-runtime: ${runtimeDigest.slice(0, 16)}...`);
console.log(`  - dependencies:     ${depsDigest.slice(0, 16)}...`);
