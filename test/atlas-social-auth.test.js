const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createLocalStore } = require('../atlas/local-store');
const { createAtlasRouter } = require('../atlas/router');
const { hashPassword } = require('../atlas/accounts');

const password = 'a-long-social-test-password-42';
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-social-auth-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const store = createLocalStore(path.join(folder, 'store.json'));
    const ownerId = randomUUID();
    const codes = new Map();
    const pending = new Map();
    let exchanges = 0;
    const authProviders = {
        list: () => ['google', 'github', 'microsoft'].map(id => ({ id, name: id, enabled: true })),
        async authorizationURL(id, { state, codeVerifier }) {
            pending.set(state, { provider: id, verifier: codeVerifier });
            const url = new URL('https://provider.example.test/authorize');
            url.searchParams.set('state', state);
            url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
            url.searchParams.set('code_challenge_method', 'S256');
            return url.href;
        },
        async identity(id, { query, state, codeVerifier }) {
            exchanges++;
            const attempt = pending.get(state);
            assert.equal(attempt.provider, id);
            assert.equal(attempt.verifier, codeVerifier);
            const params = new URLSearchParams(query);
            assert.equal(params.get('state'), state);
            const result = codes.get(params.get('code'));
            if (result instanceof Error) throw result;
            if (!result) throw new Error('Unknown fixture code');
            return result;
        }
    };
    const app = express();
    app.use(express.json());
    app.use('/api/atlas', createAtlasRouter({ store, authProviders,
        env: { SESSION_SECRET: 'social-fixture-secret', ATLAS_OWNER_ID: ownerId, ATLAS_OWNER_EMAIL: 'owner@example.test' },
        clients: { ready() {}, async complete() { return { content: 'A test reply.', tokens: 4 }; } } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/atlas';
    function client() {
        const cookies = new Map();
        const request = async (url, body, method, extraHeaders = {}) => {
            const response = await fetch(base + url, { method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
                headers: { 'Content-Type': 'application/json', Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), ...extraHeaders },
                ...(body ? { body: JSON.stringify(body) } : {}) });
            const setCookies = response.headers.getSetCookie();
            for (const cookie of setCookies) {
                const [key, ...value] = cookie.split(';')[0].split('=');
                if (!value.join('=')) cookies.delete(key);
                else cookies.set(key, value.join('='));
            }
            return { status: response.status, data: await response.json().catch(() => null),
                location: response.headers.get('location'), setCookies, referrerPolicy: response.headers.get('referrer-policy') };
        };
        request.cookies = cookies;
        return request;
    }
    async function start(request, provider = 'google', body = { acceptTerms: true }) {
        const result = await request('/auth/oauth/' + provider + '/start', body);
        assert.equal(result.status, 200);
        const url = new URL(result.data.url);
        return { state: url.searchParams.get('state'), provider, url, result };
    }
    async function callback(request, attempt, identity, extra = '') {
        const code = randomUUID();
        codes.set(code, identity);
        return request('/auth/oauth/' + attempt.provider + '/callback?state=' + attempt.state + '&code=' + code + extra);
    }
    async function native(email, options = {}) {
        return store.createUser({ _id: options.id || randomUUID(), email, name: 'Fixture account',
            passwordHash: await hashPassword(password), createdAt: new Date().toISOString(), ...options });
    }
    return { store, ownerId, client, start, callback, native, codes, pending, authProviders, exchanges: () => exchanges };
}

test('social signup creates a private account, owns saved history, and signs in again without new consent', async t => {
    const f = await fixture(t);
    const member = f.client(), stranger = f.client();
    const list = await member('/auth/providers');
    assert.deepEqual(list.data.providers.map(provider => provider.id), ['google', 'github', 'microsoft']);
    assert.ok(list.data.providers.every(provider => provider.enabled === true));
    const attempt = await f.start(member);
    assert.match(attempt.state, /^[a-f0-9]{64}$/);
    assert.equal(attempt.url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(attempt.url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(attempt.result.setCookies.some(cookie => cookie.startsWith('atlas_oauth=') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax')));
    const completed = await f.callback(member, attempt, { subject: 'google-member', email: 'social@example.test', name: 'Social member' });
    assert.equal(completed.status, 303);
    assert.equal(completed.location, '/atlas?auth=success');
    assert.equal(completed.referrerPolicy, 'no-referrer');
    assert.ok(completed.setCookies.some(cookie => cookie.startsWith('atlas_auth=') && cookie.includes('HttpOnly')));
    const profile = (await member('/profile')).data;
    assert.equal(profile.mode, 'account');
    assert.deepEqual(profile.user.providers, ['google']);
    assert.equal(profile.user.hasPassword, false);
    assert.equal(profile.user.isAdmin, false);
    assert.equal(profile.user.passwordHash, undefined);
    assert.equal(profile.user.identities, undefined);
    assert.equal(profile.user.authVersion, undefined);
    const privateUser = await f.store.userById(profile.user.id);
    assert.ok(privateUser.termsAcceptedAt && privateUser.termsVersion);
    assert.equal(privateUser.passwordHash, undefined);
    const chat = (await member('/conversations', {})).data;
    assert.equal((await stranger('/conversations/' + chat.id)).status, 404);
    assert.deepEqual((await stranger('/conversations')).data, []);
    assert.equal((await member('/admin/overview')).status, 403);
    const returning = f.client();
    assert.equal((await f.callback(returning, await f.start(returning, 'google', {}),
        { subject: 'google-member', email: 'changed@example.test', name: 'Changed name' })).location, '/atlas?auth=success');
    assert.equal((await returning('/profile')).data.user.id, profile.user.id);
    assert.equal((await returning('/conversations')).data[0].id, chat.id);
    assert.equal((await stranger('/auth/login', { email: 'social@example.test', password })).status, 401);
});

test('social account creation enforces consent, usable email, owner reservation, and paused registration', async t => {
    const f = await fixture(t);
    const visitor = f.client();
    const noTerms = await f.start(visitor, 'google', {});
    assert.equal((await f.callback(visitor, noTerms, { subject: 'no-consent', email: 'new@example.test' })).location,
        '/atlas?auth=error&reason=terms_required');
    assert.equal(await f.store.userByIdentity('google', 'no-consent'), null);
    assert.equal((await f.callback(visitor, await f.start(visitor), { subject: 'no-email', email: '' })).location,
        '/atlas?auth=error&reason=email_unavailable');
    assert.equal((await f.callback(visitor, await f.start(visitor), { subject: 'owner-claim', email: 'owner@example.test' })).location,
        '/atlas?auth=error&reason=email_conflict');
    const original = await f.native('existing@example.test');
    assert.equal((await f.callback(visitor, await f.start(visitor), { subject: 'matching-email', email: original.email })).location,
        '/atlas?auth=error&reason=email_conflict');
    assert.equal(await f.store.userByIdentity('google', 'matching-email'), null);
    assert.equal((await visitor('/profile')).data.mode, 'guest');
    await f.store.saveSettings({ registrationEnabled: false });
    assert.equal((await f.callback(visitor, await f.start(visitor), { subject: 'registration-paused', email: 'paused@example.test' })).location,
        '/atlas?auth=error&reason=registration_closed');
    assert.equal(await f.store.userByEmail('paused@example.test'), null);
    const existing = await f.store.createUser({ _id: randomUUID(), email: 'known@example.test',
        identities: [{ provider: 'microsoft', subject: 'known-microsoft' }] });
    assert.equal((await f.callback(visitor, await f.start(visitor, 'microsoft', {}), { subject: 'known-microsoft', email: existing.email })).location,
        '/atlas?auth=success');
    await f.store.bumpUserAuth(existing._id, { disabled: true });
    assert.equal((await f.callback(visitor, await f.start(visitor, 'microsoft', {}), { subject: 'known-microsoft', email: existing.email })).location,
        '/atlas?auth=error&reason=account_unavailable');
    assert.equal((await visitor('/profile')).data.mode, 'guest');
});

test('OAuth callbacks bind state to the browser and provider and consume successful attempts only once', async t => {
    const f = await fixture(t);
    const first = f.client(), second = f.client(), empty = f.client();
    const firstAttempt = await f.start(first);
    await f.start(second);
    const identity = { subject: 'bound-user', email: 'bound@example.test' };
    assert.equal((await f.callback(empty, firstAttempt, identity)).location, '/atlas?auth=error&reason=expired');
    assert.equal((await f.callback(second, firstAttempt, identity)).location, '/atlas?auth=error&reason=expired');
    assert.equal((await f.callback(first, { ...firstAttempt, provider: 'github' }, identity)).location, '/atlas?auth=error&reason=expired');
    assert.equal(f.exchanges(), 0);
    assert.equal((await f.callback(first, firstAttempt, identity)).location, '/atlas?auth=success');
    assert.equal(f.exchanges(), 1);
    assert.equal((await f.callback(first, firstAttempt, identity)).location, '/atlas?auth=error&reason=expired');
    assert.equal(f.exchanges(), 1);
    const duplicate = await f.start(first);
    assert.equal((await f.callback(first, duplicate, identity, '&state=' + duplicate.state)).location,
        '/atlas?auth=error&reason=expired');
    assert.equal((await f.callback(first, duplicate, identity)).location, '/atlas?auth=success');
    const cancelled = await f.start(first);
    assert.equal((await first('/auth/oauth/google/callback?state=' + cancelled.state + '&error=access_denied')).location,
        '/atlas?auth=error&reason=cancelled');
    assert.equal((await f.callback(first, cancelled, identity)).location, '/atlas?auth=error&reason=expired');
    const createAttempt = f.store.createOAuthAttempt;
    f.store.createOAuthAttempt = attempt => createAttempt({ ...attempt, expiresAt: new Date(Date.now() - 1).toISOString() });
    const expired = await f.start(second);
    f.store.createOAuthAttempt = createAttempt;
    assert.equal((await f.callback(second, expired, identity)).location, '/atlas?auth=error&reason=expired');
    assert.equal(await f.store.userByIdentity('google', 'unexpected'), null);
});

test('linking a provider requires the current password and preserves the existing account and owner identity', async t => {
    const f = await fixture(t);
    const user = await f.native('owner@example.test', { id: f.ownerId });
    const owner = f.client(), anonymous = f.client();
    assert.equal((await anonymous('/auth/oauth/google/start', { link: true, currentPassword: password })).status, 401);
    assert.equal((await owner('/auth/login', { email: user.email, password })).status, 200);
    assert.equal((await owner('/auth/oauth/google/start', { link: true })).status, 401);
    assert.equal((await owner('/auth/oauth/google/start', { link: true, currentPassword: 'wrong-password' })).status, 401);
    const attempt = await f.start(owner, 'google', { link: true, currentPassword: password });
    assert.equal((await f.callback(owner, attempt, { subject: 'owner-google', email: user.email })).location, '/atlas?auth=linked');
    const profile = (await owner('/profile')).data.user;
    assert.equal(profile.id, user._id);
    assert.equal(profile.hasPassword, true);
    assert.equal(profile.isAdmin, true);
    assert.deepEqual(profile.providers, ['google']);
    assert.equal((await owner('/admin/overview')).status, 200);
    const returning = f.client();
    assert.equal((await f.callback(returning, await f.start(returning, 'google', {}),
        { subject: 'owner-google', email: user.email })).location, '/atlas?auth=success');
    assert.equal((await returning('/profile')).data.user.id, user._id);
    assert.equal((await returning('/profile')).data.user.isAdmin, true);
    const unrelated = f.client();
    assert.equal((await f.callback(unrelated, await f.start(unrelated), { subject: 'another-google', email: user.email })).location,
        '/atlas?auth=error&reason=email_conflict');
    assert.equal((await unrelated('/admin/overview')).status, 401);
});

test('provider identities cannot be claimed by another account or replaced silently', async t => {
    const f = await fixture(t);
    const first = await f.native('first@example.test', { identities: [{ provider: 'google', subject: 'first-google' }] });
    const second = await f.native('second@example.test');
    const firstClient = f.client(), secondClient = f.client();
    await firstClient('/auth/login', { email: first.email, password });
    await secondClient('/auth/login', { email: second.email, password });
    const stolen = await f.start(secondClient, 'google', { link: true, currentPassword: password });
    assert.equal((await f.callback(secondClient, stolen, { subject: 'first-google', email: first.email })).location,
        '/atlas?auth=error&reason=link_conflict');
    assert.equal((await f.store.userByIdentity('google', 'first-google'))._id, first._id);
    assert.deepEqual((await secondClient('/profile')).data.user.providers, []);
    const replacement = await f.start(firstClient, 'google', { link: true, currentPassword: password });
    assert.equal((await f.callback(firstClient, replacement, { subject: 'replacement-google', email: 'another@example.test' })).location,
        '/atlas?auth=error&reason=link_conflict');
    assert.equal(await f.store.userByIdentity('google', 'replacement-google'), null);
    const idempotent = await f.start(firstClient, 'google', { link: true, currentPassword: password });
    assert.equal((await f.callback(firstClient, idempotent, { subject: 'first-google', email: first.email })).location, '/atlas?auth=linked');
    assert.equal((await f.store.userById(first._id)).identities.length, 1);
});

test('pending account links cannot survive account switches, revocation, or a concurrent password change', async t => {
    const f = await fixture(t);
    const first = await f.native('first@example.test');
    const second = await f.native('second@example.test');
    const original = f.client(), switched = f.client();
    await original('/auth/login', { email: first.email, password });
    await switched('/auth/login', { email: second.email, password });
    const switchAttempt = await f.start(original, 'github', { link: true, currentPassword: password });
    switched.cookies.set('atlas_oauth', original.cookies.get('atlas_oauth'));
    assert.equal((await f.callback(switched, switchAttempt, { subject: 'switch-target', email: first.email })).location,
        '/atlas?auth=error&reason=link_expired');
    assert.equal(await f.store.userByIdentity('github', 'switch-target'), null);
    const staleAttempt = await f.start(original, 'github', { link: true, currentPassword: password });
    await f.store.bumpUserAuth(first._id);
    assert.equal((await f.callback(original, staleAttempt, { subject: 'revoked-target', email: first.email })).location,
        '/atlas?auth=error&reason=link_expired');
    assert.equal(await f.store.userByIdentity('github', 'revoked-target'), null);
    await original('/auth/login', { email: first.email, password });
    const racingAttempt = await f.start(original, 'github', { link: true, currentPassword: password });
    const linkIdentity = f.store.linkIdentity;
    f.store.linkIdentity = async (...args) => {
        await f.store.bumpUserAuth(first._id);
        return linkIdentity(...args);
    };
    assert.equal((await f.callback(original, racingAttempt, { subject: 'racing-target', email: first.email })).location,
        '/atlas?auth=error&reason=link_expired');
    f.store.linkIdentity = linkIdentity;
    assert.equal(await f.store.userByIdentity('github', 'racing-target'), null);
});

test('logging out during an OAuth exchange prevents the pending account link', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const user = await f.native('logout-during-link@example.test');
    const member = f.client();
    await member('/auth/login', { email: user.email, password });
    const attempt = await f.start(member, 'github', { link: true, currentPassword: password });
    let releaseExchange, markExchangeStarted;
    const exchangeStarted = new Promise(resolve => { markExchangeStarted = resolve; });
    const exchangeReleased = new Promise(resolve => { releaseExchange = resolve; });
    const identity = f.authProviders.identity;
    f.authProviders.identity = async (...args) => {
        markExchangeStarted();
        await exchangeReleased;
        return identity(...args);
    };
    const pendingCallback = f.callback(member, attempt, { subject: 'logout-target', email: user.email });
    await exchangeStarted;
    try {
        assert.equal((await member('/auth/logout', {})).status, 204);
    } finally { releaseExchange(); }
    assert.equal((await pendingCallback).location, '/atlas?auth=error&reason=link_expired');
    assert.equal(await f.store.userByIdentity('github', 'logout-target'), null);
    assert.equal((await member('/profile')).data.mode, 'guest');
});

test('passwordless links require recent authentication and provider failures expose no secret details', async t => {
    const f = await fixture(t);
    const member = f.client();
    assert.equal((await f.callback(member, await f.start(member), { subject: 'social-user', email: 'social@example.test' })).location,
        '/atlas?auth=success');
    const linked = await f.start(member, 'github', { link: true });
    assert.equal((await f.callback(member, linked, { subject: 'social-github', email: 'social@example.test' })).location,
        '/atlas?auth=linked');
    const sessionByHash = f.store.sessionByHash;
    f.store.sessionByHash = async hash => {
        const session = await sessionByHash(hash);
        return session && { ...session, createdAt: new Date(Date.now() - 6 * 60_000).toISOString() };
    };
    assert.equal((await member('/auth/oauth/microsoft/start', { link: true })).status, 401);
    f.store.sessionByHash = sessionByHash;
    const failure = await f.callback(member, await f.start(member, 'microsoft'), new Error('provider token=never-expose-this'));
    assert.equal(failure.location, '/atlas?auth=error&reason=provider_failed');
    assert.equal(JSON.stringify(failure).includes('never-expose-this'), false);
    const createAttempt = f.store.createOAuthAttempt;
    let savedAttempt;
    f.store.createOAuthAttempt = async attempt => { savedAttempt = attempt; return createAttempt(attempt); };
    const malformed = await f.start(member, 'microsoft');
    assert.equal((await member('/auth/oauth/microsoft/callback?state=' + malformed.state + '&code=a&code=b')).location,
        '/atlas?auth=error&reason=provider_failed');
    assert.equal(await f.store.consumeOAuthAttempt(digest(malformed.state), savedAttempt.browserHash, 'microsoft'), null);
});
