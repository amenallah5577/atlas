const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { createProviders, publicOrigin } = require('../atlas/oauth-providers');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'fixture' };
const verifier = 'a'.repeat(64), state = 'b'.repeat(64);
const nonce = createHash('sha256').update(verifier).digest('base64url');
function jwt(patch = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'fixture-client', sub: 'google-subject',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, ...patch })).toString('base64url');
    const data = header + '.' + payload;
    return data + '.' + sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
}
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function fixture(id, { claims = {}, profilePatch = {}, tamper = false } = {}) {
    const requests = [];
    const env = { ATLAS_PUBLIC_URL: 'https://atlas.example', ['ATLAS_' + id.toUpperCase() + '_CLIENT_ID']: 'fixture-client',
        ['ATLAS_' + id.toUpperCase() + '_CLIENT_SECRET']: 'fixture-secret' };
    const providers = createProviders(env, async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith('/token') || url.endsWith('/access_token')) {
            let token = jwt(claims);
            if (tamper) token = token.slice(0, -12) + 'abcdefghijkl';
            return response({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300,
                ...(id === 'google' ? { id_token: token } : {}) });
        }
        if (url.endsWith('/certs')) return response({ keys: [jwk] });
        if (url.endsWith('/userinfo')) return response({ sub: 'google-subject', email: 'person@example.test', email_verified: true, name: 'Person', ...profilePatch });
        if (url.endsWith('/user/emails')) return response([{ email: 'hidden@example.test', primary: false, verified: true },
            { email: 'person@example.test', primary: true, verified: true, ...profilePatch }]);
        if (url.endsWith('/user')) return response({ id: 123, login: 'person', name: 'Person' });
        if (url.includes('/v1.0/me?')) return response({ id: 'microsoft-subject', displayName: 'Person', mail: 'person@example.test', ...profilePatch });
        throw new Error('Unexpected fixture request: ' + url);
    });
    return { providers, requests };
}

test('social providers require credentials and a pinned safe public origin', () => {
    assert.equal(publicOrigin({ NODE_ENV: 'production' }), null);
    assert.equal(publicOrigin({ NODE_ENV: 'production', ATLAS_PUBLIC_URL: 'http://atlas.example' }), null);
    for (const value of ['https://name:secret@atlas.example', 'https://atlas.example/path', 'https://atlas.example?next=evil', 'https://atlas.example/#fragment']) {
        assert.equal(publicOrigin({ ATLAS_PUBLIC_URL: value }), null);
    }
    assert.equal(publicOrigin({ PORT: '3182' }), 'http://127.0.0.1:3182');
    assert.equal(createProviders({}).list().some(item => item.enabled), false);
});

for (const id of ['google', 'github', 'microsoft']) {
    test(id + ' uses a pinned authorization URL, state, S256 PKCE, and a server-side code exchange', async () => {
        const { providers, requests } = fixture(id);
        const url = new URL(await providers.authorizationURL(id, { state, codeVerifier: verifier }));
        assert.equal(url.protocol, 'https:');
        assert.equal(url.searchParams.get('state'), state);
        assert.equal(url.searchParams.get('code_challenge'), nonce);
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://atlas.example/api/atlas/auth/oauth/' + id + '/callback');
        assert.equal(url.searchParams.has('client_secret'), false);
        const result = await providers.identity(id, { state, codeVerifier: verifier, query: 'code=fixture-code&state=' + state });
        assert.equal(result.email, 'person@example.test');
        assert.equal(result.name, 'Person');
        assert.deepEqual(Object.keys(result).sort(), ['email', 'emailVerified', 'name', 'subject']);
        assert.equal(result.emailVerified, id !== 'microsoft');
        const body = new URLSearchParams(requests[0].init.body);
        assert.equal(body.get('code_verifier'), verifier);
        assert.equal(body.get('client_secret'), 'fixture-secret');
        assert.equal(body.get('redirect_uri'), url.searchParams.get('redirect_uri'));
    });
}

test('Google rejects an invalid signature, nonce, audience, issuer, expiry, or UserInfo subject', async () => {
    for (const options of [{ tamper: true }, { claims: { nonce: 'wrong' } }, { claims: { aud: 'another-client' } },
        { claims: { iss: 'https://attacker.example' } }, { claims: { exp: 1 } }, { profilePatch: { sub: 'another-person' } }]) {
        const { providers } = fixture('google', options);
        await assert.rejects(providers.identity('google', { state, codeVerifier: verifier, query: 'code=fixture-code&state=' + state }));
    }
});

test('unverified Google and GitHub addresses cannot supply a signup email', async () => {
    for (const [id, profilePatch] of [['google', { email_verified: false }], ['github', { verified: false }]]) {
        const { providers } = fixture(id, { profilePatch });
        assert.equal((await providers.identity(id, { state, codeVerifier: verifier, query: 'code=fixture-code&state=' + state })).email, '');
    }
});

test('removed providers cannot become available through stale environment credentials', async () => {
    const providers = createProviders({ ATLAS_PUBLIC_URL: 'https://atlas.example',
        ATLAS_DISCORD_CLIENT_ID: 'stale-client', ATLAS_DISCORD_CLIENT_SECRET: 'stale-secret' });
    assert.deepEqual(providers.list().map(provider => provider.id), ['google', 'github', 'microsoft']);
    assert.equal(providers.list().some(provider => provider.enabled), false);
    await assert.rejects(providers.authorizationURL('discord', { state, codeVerifier: verifier }), { status: 503 });
});

test('code exchange rejects the wrong OAuth state before contacting the provider', async () => {
    const { providers, requests } = fixture('github');
    await assert.rejects(providers.identity('github', { state, codeVerifier: verifier, query: 'code=fixture-code&state=wrong' }));
    assert.equal(requests.length, 0);
});
