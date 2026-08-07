#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    commitCurrentMessageText,
    isMessageAiFinal,
    isMessageAiFinalForBranch,
    writeMessageDiffManualFinal,
    restoreMessageAiFinal,
    writeMessageDiffAiTrace,
    writeMessageDiffMeta,
} from '../src/messageMeta.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const coreSource = fs.readFileSync(path.join(repoRoot, 'src', 'core.js'), 'utf8');

const original = '<content>八股原文</content>';
const program = '<content>程序处理稿</content>';
const final = '<content>AI 改写终稿</content>';

function registerAiFinal(msg, branchKey = 'main') {
    writeMessageDiffMeta(msg, branchKey, original, final, 'source-signature');
    assert.equal(commitCurrentMessageText(msg, final, branchKey).ok, true);
    writeMessageDiffAiTrace(msg, branchKey, program, final);
}

const message = {
    is_user: false,
    mes: final,
    extra: { display_text: original },
};
registerAiFinal(message);
assert.equal(isMessageAiFinal(message), true);
assert.equal(restoreMessageAiFinal(message), true, '应清除旧显示缓存');
assert.equal(message.mes, final);
assert.equal(Object.hasOwn(message.extra, 'display_text'), false);

message.mes = original;
message.extra.display_text = original;
assert.equal(restoreMessageAiFinal(message), true, '应从持久化 AI 终稿恢复被覆盖的正文');
assert.equal(message.mes, final);
assert.equal(isMessageAiFinal(message), true);

message.mes = '<content>用户手动编辑</content>';
writeMessageDiffManualFinal(message);
assert.equal(restoreMessageAiFinal(message), false, '手动最终稿不应被 AI 终稿恢复覆盖');
assert.equal(message.mes, '<content>用户手动编辑</content>');

const swipeMessage = {
    is_user: false,
    swipe_id: 0,
    mes: original,
    swipes: [original],
};
registerAiFinal(swipeMessage, 'swipe:0');
swipeMessage.mes = original;
swipeMessage.swipes[0] = original;
assert.equal(restoreMessageAiFinal(swipeMessage), true, '应恢复当前 swipe 的 AI 终稿');
assert.equal(swipeMessage.mes, final);
assert.equal(swipeMessage.swipes[0], final);
assert.equal(isMessageAiFinalForBranch(swipeMessage, 'swipe:0', final), true);

assert.match(coreSource, /if \(isMessageAiFinal\(msg\)\) return currentMes;/u);
assert.match(coreSource, /if \(isMessageAiFinal\(msg\)\) return false;/u);
assert.match(coreSource, /restoreMessageAiFinal\(msg\)/u);
assert.match(coreSource, /export function restoreAiFinalMessagesFromChat\(\)/u);

console.log('AI 终稿持久化与恢复验证通过');
