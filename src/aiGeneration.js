import { normalizeAiSamplingSettings } from './state.js';

export function buildAiRewriteGenerateRawConfig(prompt, aiSettings = {}, generationId = '') {
    const sampling = normalizeAiSamplingSettings(aiSettings);
    const customIncludeBody = {
        response_format: { type: 'json_object' },
    };
    const customApi = {
        apiurl: String(aiSettings.baseUrl || '').trim(),
        key: String(aiSettings.apiKey || ''),
        model: String(aiSettings.model || '').trim(),
        source: 'custom',
        temperature: sampling.temperature,
        top_p: sampling.topP,
        frequency_penalty: sampling.frequencyPenalty,
        presence_penalty: sampling.presencePenalty,
        custom_include_body: customIncludeBody,
    };

    // These fields are optional in TavernHelper and are omitted at their neutral defaults.
    if (sampling.topK > 0) customApi.top_k = sampling.topK;
    if (sampling.repetitionPenalty !== 1) customIncludeBody.repetition_penalty = sampling.repetitionPenalty;
    if (sampling.maxTokens > 0) customApi.max_tokens = sampling.maxTokens;

    return {
        generation_id: String(generationId || ''),
        ordered_prompts: [{ role: 'user', content: String(prompt ?? '') }],
        should_stream: false,
        custom_api: customApi,
    };
}
