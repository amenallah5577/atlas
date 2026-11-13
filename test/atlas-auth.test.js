const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createLocalStore } = require('../atlas/local-store');
const { createAtlasRouter } = require('../atlas/router');
const { hashPassword } = require('../atlas/accounts');
const express = require('express');
const { emailFixture } = require('../test-support/email');

test('real accounts isolate history and restrict moderation to the configured owner', async t => {
    const folder = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'atlas-auth-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const store = createLocalStore(path.join(folder, 'accounts.json'));
    const emailDelivery = emailFixture();
    const ownerId = randomUUID();
    const password = 'a-long-test-password-42';
    await store.createUser({ _id: ownerId, email: 'owner@example.test', name: 'Owner',
        passwordHash: await hashPassword(password), emailVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    const app = express();
    app.use(express.json());
    app.use('/api/atlas', createAtlasRouter({ store, emailDelivery,
        env: { SESSION_SECRET: 'fixture-session-secret', ATLAS_OWNER_ID: ownerId, ATLAS_OWNER_EMAIL: 'owner@example.test' },
        clients: { ready() {}, async complete() { return { content: 'A test reply.', tokens: 4 }; } } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => server.close());
    const base = 'http://127.0.0.1:' + server.address().port + '/api/atlas';
    function client() {
        const cookies = new Map();
        return async function call(url, body, method, origin) {
            const response = await fetch(base + url, { method: method || (body ? 'POST' : 'GET'),
                headers: { 'Content-Type': 'application/json', Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '),
                    ...(origin ? { Origin: origin } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}) });
            for (const cookie of response.headers.getSetCookie()) {
                const [key, ...value] = cookie.split(';')[0].split('=');
                cookies.set(key, value.join('='));
            }
            const data = await response.json().catch(() => null);
            if (response.status === 202 && data?.verification) {
                return call('/auth/verification/confirm', { verificationId: data.verification.id, code: emailDelivery.sent.get(data.verification.email).code });
            }
            return { status: response.status, data };
        };
    }
    const visitor = client(), regular = client(), owner = client(), other = client();
    assert.equal((await visitor('/admin/overview')).status, 401);
    assert.equal((await visitor('/auth/register', { email: 'owner@example.test', password, acceptTerms: true })).status, 409);
    assert.equal((await regular('/auth/register', { email: 'first@example.test', password })).status, 400);
    const registration = await regular('/auth/register', { email: 'first@example.test', password, acceptTerms: true, role: 'admin' });
    assert.equal(registration.status, 201);
    assert.equal(registration.data.user.isAdmin, false);
    const firstId = registration.data.user.id;
    const secondId = (await other('/auth/register', { email: 'second@example.test', password, acceptTerms: true })).data.user.id;
    assert.equal((await regular('/admin/overview')).status, 403);
    const chat = (await regular('/conversations', {}, 'POST')).data;
    assert.equal((await other('/conversations/' + chat.id)).status, 404);
    const run = (await regular('/conversations/' + chat.id + '/messages',
        { text: 'Hello', clientId: randomUUID() })).data.run;
    for (let i = 0; i < 60; i++) {
        if ((await regular('/runs/' + run)).data.state !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const ownerLogin = await owner('/auth/login', { email: 'owner@example.test', password });
    assert.equal(ownerLogin.data.user.isAdmin, true);
    assert.equal((await owner('/admin/overview')).data.userCount, 3);
    const history = (await owner('/admin/conversations?owner=account:' + firstId)).data.conversations;
    assert.equal(history.length, 1);
    assert.equal((await owner('/admin/conversations/' + chat.id)).data.messages[0].text, 'Hello');
    const accounts = (await owner('/admin/users')).data.users;
    assert.equal(accounts.some(user => user.passwordHash), false);
    assert.equal((await owner('/admin/users/' + ownerId, { disabled: true }, 'PATCH')).status, 400);
    assert.equal((await owner('/admin/users/' + firstId, { disabled: true }, 'PATCH')).status, 200);
    assert.equal((await regular('/profile')).data.mode, 'guest');
    assert.equal((await regular('/auth/login', { email: 'first@example.test', password })).status, 401);
    await owner('/admin/users/' + firstId, { disabled: false }, 'PATCH');
    assert.equal((await regular('/auth/login', { email: 'first@example.test', password })).status, 200);
    assert.equal((await owner('/admin/settings', { registrationEnabled: false }, 'PATCH')).status, 200);
    assert.equal((await visitor('/auth/register', { email: 'third@example.test', password, acceptTerms: true })).status, 403);
    assert.equal((await owner('/admin/settings', { registrationEnabled: true }, 'PATCH', 'https://evil.example')).status, 403);
    assert.equal((await owner('/admin/conversations/' + chat.id + '/review', { note: 'Reviewed with no violation.' })).status, 204);
    const audit = (await owner('/admin/audit')).data.events;
    assert.ok(audit.some(event => event.action === 'research.requested' && event.note === 'Hello'));
    assert.ok(audit.some(event => event.note === 'Reviewed with no violation.'));
    const newPassword = 'a-different-long-password-85';
    const originalAudit = store.audit;
    let releaseLogin, loginReached;
    const waitForRelease = new Promise(resolve => { releaseLogin = resolve; });
    const reached = new Promise(resolve => { loginReached = resolve; });
    store.audit = async entry => {
        if (entry.action === 'account.login' && entry.actor === 'account:' + secondId) {
            loginReached();
            await waitForRelease;
        }
        return originalAudit(entry);
    };
    const staleLoginClient = client();
    const staleLogin = staleLoginClient('/auth/login', { email: 'second@example.test', password });
    await reached;
    try {
        assert.equal((await other('/auth/password', { currentPassword: password, newPassword })).status, 204);
    } finally {
        releaseLogin();
        store.audit = originalAudit;
    }
    assert.equal((await staleLogin).status, 401);
    assert.equal((await staleLoginClient('/profile')).data.mode, 'guest');
    assert.equal((await other('/profile')).data.user.id, secondId);
    assert.equal((await other('/auth/logout', {}, 'POST')).status, 204);
    assert.equal((await other('/auth/login', { email: 'second@example.test', password })).status, 401);
    assert.equal((await other('/auth/login', { email: 'second@example.test', password: newPassword })).status, 200);
    assert.equal((await owner('/auth/logout', {}, 'POST')).status, 204);
    assert.equal((await owner('/admin/overview')).status, 401);
});
