const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const express = require('express');
const sharp = require('sharp');
const { createLocalStore } = require('../atlas/local-store');
const { createAtlasRouter } = require('../atlas/router');
const { hashPassword } = require('../atlas/accounts');
const { preferences, parental, preferencePatch } = require('../atlas/account-preferences');

const password = 'settings-fixture-password-4862';
async function fixture(t) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-settings-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const store = createLocalStore(path.join(folder, 'store.json'));
    const ownerId = randomUUID();
    const app = express();
    app.use(express.json({ limit: '3mb' }));
    app.use('/api/atlas', createAtlasRouter({ store,
        env: { SESSION_SECRET: 'settings-fixture-secret', ATLAS_OWNER_ID: ownerId, ATLAS_OWNER_EMAIL: 'owner@example.test' },
        clients: { ready() {}, async complete() { return { content: 'A test reply.', tokens: 4 }; } } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/atlas';
    function client() {
        const cookies = new Map();
        return async (url, body, method, headers = {}) => {
            const response = await fetch(base + url, { method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
                headers: { 'Content-Type': 'application/json', Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), ...headers },
                ...(body ? { body: JSON.stringify(body) } : {}) });
            for (const cookie of response.headers.getSetCookie()) {
                const [key, ...parts] = cookie.split(';')[0].split('=');
                if (parts.join('=')) cookies.set(key, parts.join('=')); else cookies.delete(key);
            }
            return { status: response.status, data: await response.json().catch(() => null), disposition: response.headers.get('content-disposition') };
        };
    }
    async function register(email = randomUUID() + '@example.test') {
        const request = client();
        const result = await request('/auth/register', { email, password, acceptTerms: true });
        assert.equal(result.status, 201);
        return { request, user: result.data.user, email };
    }
    return { store, client, register, ownerId, folder };
}

test('account preferences validate exact types, persist, merge concurrent edits, and stay account scoped', async t => {
    const f = await fixture(t);
    const first = await f.register(), second = await f.register();
    assert.equal((await f.client()('/account')).status, 401);
    const initial = (await first.request('/account')).data;
    assert.equal(initial.preferences.theme, 'system');
    assert.equal(initial.preferences.defaultDepth, 'quick');
    assert.equal(initial.sessions.filter(session => session.current).length, 1);
    assert.equal(initial.user.hasPassword, true);
    for (const patch of [{ theme: 'unknown' }, { autoScroll: 1 }, { breakReminderMinutes: 5 }, { role: 'admin' }, { parental: { enabled: false } }, {}]) {
        assert.equal((await first.request('/account/preferences', patch, 'PATCH')).status, 400);
    }
    const results = await Promise.all([
        first.request('/account/preferences', { theme: 'dark', textSize: 'large', backgroundMotion: false }, 'PATCH'),
        first.request('/account/preferences', { defaultDepth: 'detailed', enterToSend: false, breakReminderMinutes: 30 }, 'PATCH')
    ]);
    assert.ok(results.every(result => result.status === 200));
    const saved = (await first.request('/account')).data.preferences;
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.defaultDepth, 'detailed');
    assert.equal(saved.enterToSend, false);
    assert.equal((await second.request('/account')).data.preferences.theme, 'system');
    const restarted = createLocalStore(path.join(f.folder, 'store.json'));
    assert.equal(preferences(await restarted.userById(first.user.id)).textSize, 'large');
    assert.equal((await first.request('/account/preferences', { theme: 'light' }, 'PATCH', { Origin: 'https://evil.example' })).status, 403);
});

test('profile changes persist names and normalize safe photo pixels without accepting executable formats', async t => {
    const f = await fixture(t);
    const { request, user } = await f.register();
    const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#21806c' } }).png().toBuffer();
    const changed = await request('/account/profile', { name: 'Updated display name', avatarData: 'data:image/png;base64,' + original.toString('base64') }, 'PATCH');
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.name, 'Updated display name');
    assert.match(changed.data.user.avatarUrl, /^data:image\/jpeg;base64,/);
    const avatar = await sharp(Buffer.from(changed.data.user.avatarUrl.split(',')[1], 'base64')).metadata();
    assert.equal(avatar.width, 256);
    assert.equal(avatar.height, 256);
    assert.equal(avatar.exif, undefined);
    assert.equal((await request('/profile')).data.user.avatarUrl, changed.data.user.avatarUrl);
    assert.equal((await request('/account/profile', { name: '' }, 'PATCH')).status, 400);
    assert.equal((await request('/account/profile', { name: 'Safe', isAdmin: true }, 'PATCH')).status, 400);
    for (const image of ['data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
        'data:image/png;base64,' + Buffer.from('not an image').toString('base64')]) {
        assert.equal((await request('/account/profile', { avatarData: image }, 'PATCH')).status, 400);
    }
    const giant = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: 'white' } }).png().toBuffer();
    assert.equal((await request('/account/profile', { avatarData: 'data:image/png;base64,' + giant.toString('base64') }, 'PATCH')).status, 400);
    assert.equal((await request('/account/profile', { avatarData: null }, 'PATCH')).data.user.avatarUrl, '');
    assert.equal((await f.store.userById(user.id)).name, 'Updated display name');
});

test('parental controls verify passwords and PINs, rotate securely, and never expose PIN material', async t => {
    const f = await fixture(t);
    const { request, user } = await f.register();
    assert.equal((await request('/account/parental', { enabled: false, webResearch: false })).status, 200);
    assert.equal((await request('/account/parental', { enabled: true, pin: '465829' })).status, 401);
    assert.equal((await request('/account/parental', { enabled: true, pin: '123', currentPassword: password })).status, 400);
    const enabled = await request('/account/parental', { enabled: true, pin: '465829', currentPassword: password,
        webResearch: false, pdfUploads: false, contentFilter: true });
    assert.equal(enabled.status, 200);
    assert.deepEqual(enabled.data.parental, { enabled: true, webResearch: false, pdfUploads: false, contentFilter: true });
    const record = await f.store.userById(user.id);
    assert.match(record.parental.pinHash, /^scrypt\$/);
    assert.equal(JSON.stringify(record.parental).includes('465829'), false);
    assert.equal(JSON.stringify((await request('/account')).data).includes('pinHash'), false);
    assert.equal((await request('/account/parental', { enabled: false })).status, 401);
    assert.equal((await request('/account/parental', { enabled: false, pin: '000000' })).status, 401);
    assert.equal((await request('/account/preferences', { parental: { enabled: false } }, 'PATCH')).status, 400);
    assert.equal((await request('/account/parental', { enabled: true, currentPin: '465829', pin: '937516', webResearch: true })).status, 200);
    assert.equal((await request('/account/parental', { enabled: false, pin: '465829' })).status, 401);
    assert.equal((await request('/account/parental', { enabled: false, pin: '937516' })).status, 200);
    assert.equal(parental(await f.store.userById(user.id)).enabled, false);
    assert.equal((await f.store.userById(user.id)).parental.pinHash, undefined);
});

test('security settings expose only safe session IDs and revoke only the selected account sessions', async t => {
    const f = await fixture(t);
    const first = await f.register(), second = await f.register();
    const otherDevice = f.client();
    assert.equal((await otherDevice('/auth/login', { email: first.email, password })).status, 200);
    const overview = (await first.request('/account')).data;
    assert.equal(overview.sessions.length, 2);
    const target = overview.sessions.find(session => !session.current);
    const raw = await f.store.listUserSessions(first.user.id);
    assert.equal(raw.some(session => session.hash === target.id), false);
    assert.equal((await second.request('/account/sessions/' + target.id, undefined, 'DELETE')).status, 404);
    assert.equal((await first.request('/account/sessions/' + overview.sessions.find(session => session.current).id, undefined, 'DELETE')).status, 400);
    assert.equal((await first.request('/account/sessions/' + target.id, undefined, 'DELETE')).status, 204);
    assert.equal((await otherDevice('/account')).status, 401);
    assert.equal((await second.request('/account')).status, 200);
    await otherDevice('/auth/login', { email: first.email, password });
    assert.equal((await first.request('/account/sessions/revoke-others', {})).status, 401);
    assert.equal((await first.request('/account/sessions/revoke-others', { currentPassword: password })).status, 204);
    assert.equal((await otherDevice('/account')).status, 401);
    assert.equal((await first.request('/account')).data.sessions.length, 1);
});

test('archiving, storage summaries, exports, and chat deletion preserve ownership and active replies', async t => {
    const f = await fixture(t);
    const first = await f.register(), second = await f.register();
    const firstOwner = 'account:' + first.user.id, secondOwner = 'account:' + second.user.id;
    const chat = (await first.request('/conversations', {})).data;
    const foreign = (await second.request('/conversations', {})).data;
    const run = randomUUID();
    await f.store.lock(firstOwner, chat.id, run);
    await f.store.finish(firstOwner, chat.id, run, 'Stored chat', [{ id: randomUUID(), role: 'user', text: 'A stored prompt.' }]);
    assert.equal((await second.request('/conversations/' + chat.id, { archived: true }, 'PATCH')).status, 404);
    assert.equal((await first.request('/conversations/' + chat.id, { archived: true }, 'PATCH')).status, 200);
    assert.equal((await first.request('/conversations')).data.length, 0);
    assert.equal((await first.request('/conversations?archived=true')).data.length, 1);
    const overview = (await first.request('/account')).data;
    assert.deepEqual({ ...overview.storage, bytes: 0 }, { conversationCount: 1, archivedCount: 1, messageCount: 1, bytes: 0 });
    assert.ok(overview.storage.bytes > 0);
    const exported = await first.request('/account/export');
    assert.match(exported.disposition, /attachment/);
    assert.equal(exported.data.conversations[0].messages[0].text, 'A stored prompt.');
    assert.equal(exported.data.conversations.some(item => item._id === foreign.id), false);
    for (const key of ['passwordHash', 'pinHash', 'codeVerifier', 'authVersion', 'identities', 'sessions']) assert.equal(JSON.stringify(exported.data).includes('"' + key + '"'), false);
    assert.equal((await first.request('/conversations/' + chat.id, { archived: false }, 'PATCH')).status, 200);
    await f.store.lock(firstOwner, chat.id, run);
    assert.equal((await first.request('/account/delete-chats', { confirmation: 'DELETE' })).status, 409);
    assert.ok(await f.store.get(firstOwner, chat.id));
    await f.store.finish(firstOwner, chat.id, run, 'Stored chat', []);
    assert.equal((await first.request('/account/delete-chats', {})).status, 400);
    assert.equal((await first.request('/account/delete-chats', { confirmation: 'DELETE' })).data.deleted, 1);
    assert.equal(await f.store.get(firstOwner, chat.id), null);
    assert.ok(await f.store.get(secondOwner, foreign.id));
});

test('account deletion needs confirmation and authentication, protects the owner, and revokes all owned data', async t => {
    const f = await fixture(t);
    const first = await f.register(), second = await f.register();
    const firstOwner = 'account:' + first.user.id;
    const chat = (await first.request('/conversations', {})).data;
    assert.equal((await first.request('/account', { currentPassword: password }, 'DELETE')).status, 400);
    assert.equal((await first.request('/account', { confirmation: 'DELETE', currentPassword: 'wrong' }, 'DELETE')).status, 401);
    const run = randomUUID();
    await f.store.lock(firstOwner, chat.id, run);
    assert.equal((await first.request('/account', { confirmation: 'DELETE', currentPassword: password }, 'DELETE')).status, 409);
    await f.store.finish(firstOwner, chat.id, run, 'Chat', []);
    await f.store.createUser({ _id: f.ownerId, email: 'owner@example.test', name: 'Owner', passwordHash: await hashPassword(password) });
    const owner = f.client();
    await owner('/auth/login', { email: 'owner@example.test', password });
    assert.equal((await owner('/account', { confirmation: 'DELETE', currentPassword: password }, 'DELETE')).status, 403);
    assert.equal((await first.request('/account', { confirmation: 'DELETE', currentPassword: password }, 'DELETE')).status, 204);
    assert.equal(await f.store.userById(first.user.id), null);
    assert.equal((await f.store.listUserSessions(first.user.id)).length, 0);
    assert.equal((await f.store.listAllConversations(firstOwner)).length, 0);
    assert.equal((await first.request('/account')).status, 401);
    assert.equal((await second.request('/account')).status, 200);
    assert.ok((await f.store.listAudit(100)).some(entry => entry.action === 'account.deleted' && entry.target === first.user.id));
});

test('preference and parental helpers discard unrecognized stored values and private material', () => {
    assert.equal(preferences({ preferences: { theme: 'invalid', enterToSend: 'yes' } }).theme, 'system');
    assert.equal(preferences({ preferences: { theme: 'invalid', enterToSend: 'yes' } }).enterToSend, true);
    assert.deepEqual(parental({ parental: { enabled: true, pinHash: 'secret', webResearch: false } }),
        { enabled: true, webResearch: false, pdfUploads: true, contentFilter: false });
    assert.throws(() => preferencePatch({ constructor: true }), error => error.status === 400);
});

test('social-only accounts manage settings and require recent authentication for sensitive changes', async t => {
    const f = await fixture(t);
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    await f.store.createUser({ _id: id, email: 'social-only@example.test', identities: [{ provider: 'google', subject: 'settings-subject' }] });
    await f.store.createSession({ hash, userId: id, authVersion: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const request = f.client(), headers = { Cookie: 'atlas_auth=' + token };
    assert.equal((await request('/account', undefined, 'GET', headers)).data.user.hasPassword, false);
    assert.equal((await request('/account/parental', { enabled: true, pin: '286493', contentFilter: true }, 'POST', headers)).status, 200);
    assert.equal((await request('/account/parental', { enabled: false, pin: '286493' }, 'POST', headers)).status, 200);
    await f.store.deleteSession(hash);
    await f.store.createSession({ hash, userId: id, authVersion: 0, createdAt: new Date(Date.now() - 10 * 60_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal((await request('/account/parental', { enabled: true, pin: '286493' }, 'POST', headers)).status, 401);
    assert.equal((await request('/account/sessions/revoke-others', {}, 'POST', headers)).status, 401);
    assert.equal((await request('/account', { confirmation: 'DELETE' }, 'DELETE', headers)).status, 401);
    assert.equal((await request('/account/preferences', { autoScroll: false }, 'PATCH', headers)).status, 200);
});
