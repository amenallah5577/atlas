const { createHash } = require('node:crypto');
const { AtlasError } = require('./research');

const PROVIDERS = new Set(['google', 'github', 'microsoft']);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function identity(provider, subject) {
    if (!PROVIDERS.has(provider) || typeof subject !== 'string' || !subject || subject.length > 512 || /[\x00-\x1f\x7f]/.test(subject)) {
        throw new AtlasError(400, 'Invalid sign-in identity.');
    }
    return { provider, subject, key: createHash('sha256').update(provider + ':' + subject).digest('hex') };
}

function identities(records) {
    if (records === undefined) return [];
    if (!Array.isArray(records) || records.length > PROVIDERS.size) throw new AtlasError(400, 'Invalid sign-in identities.');
    const result = records.map(record => identity(record?.provider, record?.subject));
    if (new Set(result.map(record => record.provider)).size !== result.length) {
        throw new AtlasError(400, 'Only one identity per sign-in provider is supported.');
    }
    return result;
}

function oauthAttempt(attempt) {
    const expiresAt = new Date(attempt.expiresAt);
    if (!isHash(attempt.hash) || !isHash(attempt.browserHash) || !PROVIDERS.has(attempt.provider) ||
        typeof attempt.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(attempt.codeVerifier) ||
        !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() > Date.now() + 11 * 60_000 ||
        typeof attempt.acceptTerms !== 'boolean') {
        throw new AtlasError(400, 'Invalid sign-in attempt.');
    }
    const result = { hash: attempt.hash, browserHash: attempt.browserHash, provider: attempt.provider,
        codeVerifier: attempt.codeVerifier, expiresAt: expiresAt.toISOString(), acceptTerms: attempt.acceptTerms };
    if (attempt.userId !== undefined) {
        if (typeof attempt.userId !== 'string' || !attempt.userId || attempt.userId.length > 80 ||
            !Number.isSafeInteger(attempt.authVersion) || attempt.authVersion < 0) {
            throw new AtlasError(400, 'Invalid account-linking attempt.');
        }
        result.userId = attempt.userId;
        result.authVersion = attempt.authVersion;
    }
    return result;
}

function validateAttemptLookup(hash, browserHash, provider) {
    if (!isHash(hash) || !isHash(browserHash) || !PROVIDERS.has(provider)) {
        throw new AtlasError(400, 'Invalid sign-in attempt.');
    }
}

module.exports = { identity, identities, oauthAttempt, validateAttemptLookup };
