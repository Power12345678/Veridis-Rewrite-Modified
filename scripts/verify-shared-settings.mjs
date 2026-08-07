#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const stateSource = fs.readFileSync(path.join(repoRoot, 'src', 'state.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
const readmeSource = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));

assert.match(stateSource, /export const extensionName = "ultimate_purifier_ai_rewrite"/u);
assert.match(stateSource, /export const modifiedExtensionName = "ultimate_purifier_ai_rewrite_modified"/u);
assert.match(stateSource, /diffMetadataKey = `\$\{modifiedExtensionName\}_diff_state_v3`/u);
assert.match(indexSource, /function maybeImportModifiedSettingsIntoSharedNamespace\(\)/u);
assert.match(indexSource, /extension_settings\[extensionName\] = clonePlain\(modifiedSettings\)/u);
assert.match(indexSource, /hasConfiguredAiRewrite\(settings\)/u);
assert.match(indexSource, /maybeImportModifiedSettingsIntoSharedNamespace\(\)/u);
assert.match(readmeSource, /ultimate_purifier_ai_rewrite.*共享设置/u);
assert.equal(manifest.version, '2.4-modified');

console.log('共享上游规则、预设与 AI 设置策略验证通过');
