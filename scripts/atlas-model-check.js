require('dotenv').config();
const { providerClients } = require('../atlas/research');

async function main() {
    const clients = providerClients({ env: process.env, store: {} });
    const configuration = clients.describe();
    if (!configuration.configured) throw new Error(configuration.error);
    const provider = configuration.provider;
    const headers = provider === 'ollama' ? {} : { Authorization: 'Bearer ' + process.env['ATLAS_' + provider.toUpperCase() + '_API_KEY'] };
    const endpoint = provider === 'groq' ? 'https://api.groq.com/openai/v1/models' :
        provider === 'openrouter' ? 'https://openrouter.ai/api/v1/models' : 'http://127.0.0.1:11434/api/tags';
    const response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Model availability check failed (HTTP ' + response.status + ').');
    const catalogue = await response.json();
    for (const depth of ['quick', 'detailed']) {
        const model = configuration[depth];
        const entry = provider === 'ollama' ? catalogue.models?.find(item => item.name === model) : catalogue.data?.find(item => item.id === model);
        if (!entry) throw new Error('The configured ' + depth + ' model is unavailable: ' + model);
        if (provider === 'ollama' && (entry.remote_host || entry.remote_model || /cloud/i.test(model))) throw new Error('Cloud-backed Ollama models are not allowed.');
        const zero = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number(value) === 0;
        if (provider === 'openrouter' && (!model.endsWith(':free') || !entry.pricing ||
            !zero(entry.pricing.prompt) || !zero(entry.pricing.completion) || !Object.values(entry.pricing).every(zero))) {
            throw new Error('The selected OpenRouter model is not confirmed free.');
        }
        console.log(depth + ': ' + provider + ' / ' + model + ' — available');
    }
    console.log('Availability verified. No inference requests or paid fallbacks were made.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
