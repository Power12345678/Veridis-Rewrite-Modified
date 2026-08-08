#!/usr/bin/env node

import assert from 'node:assert/strict';

import { buildAiRewriteGenerateRawConfig } from '../src/aiGeneration.js';
import { defaultAiRewriteSettings, normalizeAiSamplingSettings } from '../src/state.js';
import { buildPresetEntry, normalizePresetAiRewriteSettings } from '../src/utils.js';

const configured = {
    ...defaultAiRewriteSettings,
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'rewrite-model',
    temperature: 0.7,
    topP: 0.85,
    topK: 40,
    frequencyPenalty: 0.25,
    presencePenalty: -0.1,
    repetitionPenalty: 1.12,
    maxTokens: 2048,
};

const request = buildAiRewriteGenerateRawConfig('rewrite this', configured, 'generation-test');
assert.equal(request.generation_id, 'generation-test');
assert.equal(request.should_stream, false);
assert.deepEqual(request.ordered_prompts, [{ role: 'user', content: 'rewrite this' }]);
assert.deepEqual(request.custom_api, {
    apiurl: 'https://example.test/v1',
    key: 'test-key',
    model: 'rewrite-model',
    source: 'custom',
    temperature: 0.7,
    top_p: 0.85,
    top_k: 40,
    frequency_penalty: 0.25,
    presence_penalty: -0.1,
    max_tokens: 2048,
    custom_include_body: {
        response_format: { type: 'json_object' },
        repetition_penalty: 1.12,
    },
});

const neutralRequest = buildAiRewriteGenerateRawConfig('rewrite this', defaultAiRewriteSettings, 'neutral-test');
assert.equal(Object.hasOwn(neutralRequest.custom_api, 'top_k'), false);
assert.equal(Object.hasOwn(neutralRequest.custom_api, 'max_tokens'), false);
assert.equal(Object.hasOwn(neutralRequest.custom_api.custom_include_body, 'repetition_penalty'), false);

assert.deepEqual(normalizeAiSamplingSettings({
    temperature: 99,
    topP: -1,
    topK: 40.6,
    frequencyPenalty: -99,
    presencePenalty: 99,
    repetitionPenalty: 0,
    maxTokens: 999999,
}), {
    temperature: 2,
    topP: 0,
    topK: 41,
    frequencyPenalty: -2,
    presencePenalty: 2,
    repetitionPenalty: 1,
    maxTokens: 65536,
});

const presetSettings = normalizePresetAiRewriteSettings({
    ...configured,
    promptProtocolVersion: 2,
    promptTemplate: 'test prompt',
});
assert.equal(presetSettings.topP, 0.85);
assert.equal(presetSettings.topK, 40);
assert.equal(presetSettings.frequencyPenalty, 0.25);
assert.equal(presetSettings.presencePenalty, -0.1);
assert.equal(presetSettings.repetitionPenalty, 1.12);
assert.equal(presetSettings.maxTokens, 2048);
const presetEntry = buildPresetEntry([], presetSettings);
assert.equal(presetEntry.aiRewrite.maxTokens, 2048);
assert.equal(presetEntry.aiRewrite.topP, 0.85);

console.log('AI 生成参数请求、规范化与预设保存验证通过');
