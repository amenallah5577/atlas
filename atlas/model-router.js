const PROFILES = Object.freeze({
    quick: Object.freeze({ label: 'Quick', chatTokens: 1000, evidenceTokens: 1800, contextMessages: 8, contextChars: 6000, chatMs: 60_000 }),
    detailed: Object.freeze({ label: 'Detailed', chatTokens: 4000, evidenceTokens: 3200, contextMessages: 20, contextChars: 16000, chatMs: 120_000 })
});
const GROQ_MODELS = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
const DEFAULTS = {
    groq: { quick: 'openai/gpt-oss-20b', detailed: 'openai/gpt-oss-120b' },
    openrouter: { quick: 'google/gemma-4-26b-a4b-it:free', detailed: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    ollama: { quick: 'qwen3.5:4b', detailed: 'qwen3.5:9b' }
};
const profileFor = depth => PROFILES[depth === 'detailed' ? 'detailed' : 'quick'];

function conversationContext(messages, depth) {
    const profile = profileFor(depth);
    let remaining = profile.contextChars;
    const result = [];
    for (const message of messages.slice(-profile.contextMessages).reverse()) {
        if (!['user', 'assistant'].includes(message.role) || remaining < 100) continue;
        const report = message.report;
        const evidenceSummary = report ? [
            ...(report.findings || []).map(item => item.text), ...(report.assessments || []).map(item => item.text),
            ...(report.listings || []).map(item => Object.entries(item.fields || {}).map(([key, value]) => key + ': ' + value.text).join('; '))
        ].join('\n') : '';
        const text = [message.text || '', evidenceSummary].filter(Boolean).join('\n').trim();
        if (!text) continue;
        const content = text.slice(0, Math.min(remaining, depth === 'detailed' ? 4000 : 1800));
        remaining -= content.length;
        result.unshift({ role: message.role, content });
    }
    return result;
}

function createModelRouter({ env, store, request, AtlasError }) {
    let provider = env.ATLAS_LLM_PROVIDER || 'groq';
    if (provider === 'auto') provider = env.ATLAS_GROQ_API_KEY ? 'groq' : env.ATLAS_OPENROUTER_API_KEY ? 'openrouter' : 'ollama';
    let backoff = 0, catalogue, catalogueAt = 0, pendingCatalogue, localActive = false;
    function modelFor(depth, purpose) {
        const mode = depth === 'detailed' && purpose !== 'plan' ? 'detailed' : 'quick';
        const prefix = 'ATLAS_' + provider.toUpperCase();
        const model = env[prefix + '_' + mode.toUpperCase() + '_MODEL'] ||
            (provider === 'ollama' ? env.ATLAS_OLLAMA_MODEL : '') || DEFAULTS[provider]?.[mode];
        if (provider === 'groq' && !GROQ_MODELS.has(model)) throw new AtlasError(503, 'Choose a supported Groq free-plan model in the server configuration.');
        if (provider === 'openrouter' && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+:free$/i.test(model || '')) {
            throw new AtlasError(503, 'OpenRouter is restricted to explicit :free model IDs.');
        }
        if (provider === 'ollama' && (typeof model !== 'string' || !/^[a-z0-9_.:/-]{1,120}$/i.test(model) || /cloud/i.test(model))) {
            throw new AtlasError(503, 'Choose an installed local Ollama model.');
        }
        return model;
    }
    function ready(depth = 'quick') {
        if (!Object.hasOwn(DEFAULTS, provider)) throw new AtlasError(503, 'Choose ollama, groq, or openrouter as the Atlas provider.');
        modelFor(depth);
        if (provider !== 'ollama' && (env.ATLAS_FREE_PROVIDERS_CONFIRMED !== 'true' || !env['ATLAS_' + provider.toUpperCase() + '_API_KEY'])) {
            throw new AtlasError(503, 'Configure a confirmed free-plan ' + (provider === 'groq' ? 'Groq' : 'OpenRouter') + ' key, or use local Ollama models.');
        }
        if (backoff > Date.now()) throw new AtlasError(429, 'The free model limit has been reached. Try again later.', Math.ceil((backoff - Date.now()) / 1000));
    }
    async function responseJson(response) {
        if (!response.ok) {
            if ([429, 402].includes(response.status)) {
                const value = response.headers?.get('retry-after');
                const delay = Math.min(3600, Math.max(1, Number(value) || (Date.parse(value) - Date.now()) / 1000 || 60));
                backoff = Date.now() + delay * 1000;
                throw new AtlasError(429, 'The free model allowance is unavailable. No paid fallback was used.', Math.ceil(delay));
            }
            if ([401, 403].includes(response.status)) throw new AtlasError(503, 'The Atlas model key was rejected. Check the server configuration.');
            throw new AtlasError(502, 'The model provider could not complete the request.');
        }
        return response.json();
    }
    async function freeCatalogue(signal) {
        if (catalogue && Date.now() - catalogueAt < 5 * 60_000) return catalogue;
        if (!pendingCatalogue) pendingCatalogue = (async () => {
            const response = await request('https://openrouter.ai/api/v1/models', { signal, redirect: 'error' });
            const data = await responseJson(response);
            if (!Array.isArray(data.data)) throw new AtlasError(503, 'The free-model catalogue is unavailable.');
            catalogue = data.data;
            catalogueAt = Date.now();
            return catalogue;
        })().finally(() => { pendingCatalogue = null; });
        return pendingCatalogue;
    }
    async function reserve(model, maxTokens, messages, signal, { depth, purpose, onWait }) {
        const estimate = Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 2) + maxTokens + 100;
        if (provider === 'groq') {
            const prefix = provider + '-' + model + '-';
            const minute = async () => {
                await store.reserve(prefix + 'requests', 'minute', 1, 27);
                await store.reserve(prefix + 'tokens', 'minute', estimate, 7500);
            };
            try { await minute(); }
            catch (error) {
                // Wait only for a local minute reservation, before any provider request.
                // Provider errors are never retried or routed to a paid fallback.
                if ((depth !== 'detailed' && purpose !== 'repair') || error.status !== 429 || !(error.retryAfter > 0 && error.retryAfter <= 60)) throw error;
                onWait?.('Waiting for the free model allowance to reset');
                await require('node:timers/promises').setTimeout(error.retryAfter * 1000 + 50, undefined, { signal });
                signal.throwIfAborted();
                await minute();
            }
            await store.reserve(prefix + 'requests', 'day', 1, 950);
            await store.reserve(prefix + 'tokens', 'day', estimate, 190_000);
        } else {
            await store.reserve('openrouter-requests', 'day', 1, 40);
            await store.reserve('openrouter-requests', 'minute', 1, 10);
        }
    }
    return {
        ready,
        description() {
            try { ready(); return { provider, configured: true, quick: modelFor('quick'), detailed: modelFor('detailed') }; }
            catch (error) { return { provider, configured: false, error: error.message }; }
        },
        async complete(messages, structured, signal, { depth = 'quick', purpose = 'answer', onWait } = {}) {
            ready(depth);
            signal.throwIfAborted();
            const profile = profileFor(depth), model = modelFor(depth, purpose);
            let maxTokens = purpose === 'plan' ? 550 : structured ? profile.evidenceTokens : profile.chatTokens;
            if (provider === 'ollama') {
                if (localActive) throw new AtlasError(429, 'The local model is busy. Try again shortly.', 5);
                localActive = true;
                try {
                    let tags;
                    try { tags = await request('http://127.0.0.1:11434/api/tags', { signal, redirect: 'error' }); }
                    catch (error) { if (signal.aborted) throw error; throw new AtlasError(503, 'Start Ollama to connect the local models.'); }
                    if (!tags.ok) throw new AtlasError(503, 'Start Ollama to connect the local models.');
                    const installed = (await tags.json()).models?.find(item => item.name === model);
                    if (!installed || installed.remote_host || installed.remote_model) throw new AtlasError(503, 'Install the configured local model with ollama pull ' + model + '.');
                    const response = await request('http://127.0.0.1:11434/api/chat', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, redirect: 'error',
                        body: JSON.stringify({ model, messages, stream: false, keep_alive: '5m',
                            ...(/^qwen3(?:\.5)?:/i.test(model) ? { think: depth === 'detailed' && !structured } : {}),
                            options: { temperature: 0.2, num_ctx: depth === 'detailed' ? 12288 : 8192, num_predict: maxTokens },
                            ...(structured ? { format: 'json' } : {}) })
                    });
                    const data = await responseJson(response);
                    const content = data.message?.content;
                    if (typeof content !== 'string' || !content.trim()) throw new AtlasError(502, 'The local model returned no final answer. Try a shorter request.');
                    return { content, tokens: (data.eval_count || 0) + (data.prompt_eval_count || 0), provider, model, truncated: data.done_reason === 'length' };
                } finally { localActive = false; }
            }
            let metadata;
            if (provider === 'openrouter') {
                metadata = (await freeCatalogue(signal)).find(item => item.id === model);
                const zero = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number(value) === 0;
                if (!metadata || !metadata.pricing || !zero(metadata.pricing.prompt) || !zero(metadata.pricing.completion) ||
                    !Object.values(metadata.pricing).every(zero)) {
                    throw new AtlasError(503, 'The selected model is not confirmed free in the current catalogue. No request was sent.');
                }
            } else {
                // Keep each request inside the conservative free-plan minute allowance.
                // Keep the current question and system instructions; discard oldest context first.
                while (!structured && messages.length > 2 && Buffer.byteLength(JSON.stringify(messages)) > 12_000) {
                    messages = [messages[0], ...messages.slice(2)];
                }
                maxTokens = Math.min(maxTokens, 7400 - Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 2));
                if (maxTokens < 550) throw new AtlasError(429, 'This request is too large for the free model allowance. Shorten it or start a new chat.', 60);
            }
            await reserve(model, maxTokens, messages, signal, { depth, purpose, onWait });
            const reasoning = purpose === 'plan' ? 'low' : depth === 'detailed' ? 'high' : 'low';
            const body = provider === 'groq' ? {
                model, messages, max_completion_tokens: maxTokens,
                ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: reasoning, include_reasoning: false } : { reasoning_format: 'hidden' }),
                ...(structured ? { response_format: { type: 'json_object' } } : {})
            } : {
                model, messages, max_tokens: maxTokens,
                provider: { allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } },
                ...(metadata.supported_parameters?.includes('reasoning') ? { reasoning: { effort: reasoning, exclude: true } } : {}),
                ...(structured && metadata.supported_parameters?.includes('response_format') ? { response_format: { type: 'json_object' } } : {})
            };
            const response = await request(provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST', signal, redirect: 'error', headers: { Authorization: 'Bearer ' + env['ATLAS_' + provider.toUpperCase() + '_API_KEY'], 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await responseJson(response), content = data.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) throw new AtlasError(502, 'The model returned no final answer. Try a shorter request.');
            return { content, tokens: Number(data.usage?.total_tokens) || 0, provider, model, truncated: data.choices[0].finish_reason === 'length' };
        }
    };
}
module.exports = { PROFILES, DEFAULTS, profileFor, conversationContext, createModelRouter };
