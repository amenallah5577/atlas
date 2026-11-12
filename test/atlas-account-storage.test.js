const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createLocalStore } = require('../atlas/local-store');
const { createStore } = require('../atlas/store');

async function temporaryStore(t, seed) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-accounts-'));
    const filename = path.join(directory, 'store.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    if (seed) await fs.writeFile(filename, JSON.stringify(seed));
    return { filename, store: createLocalStore(filename) };
}
const user = (email, extra = {}) => ({
    _id: randomUUID(), email, name: 'Example User', passwordHash: 'scrypt-fixture-hash',
    createdAt: '2026-11-11T12:00:00.000Z', ...extra
});

test('account storage preserves old chats, normalizes unique emails, and redacts secrets', async t => {
    const id = randomUUID();
    const legacy = { _id: id, owner: 'guest:legacy', title: 'Existing report', messages: [], updatedAt: '2026-11-10T00:00:00.000Z' };
    const { store, filename } = await temporaryStore(t, { chats: { [id]: legacy }, quotas: {} });
    assert.equal((await store.get('guest:legacy', id)).title, 'Existing report');
    const original = user('  PERSON@Example.COM ', { role: 'admin', disabled: true });
    const created = await store.createUser(original);
    assert.equal(created.email, 'person@example.com');
    assert.equal(created.disabled, false);
    assert.equal(created.role, undefined);
    await assert.rejects(store.createUser(user('person@example.com')), { status: 409 });
    const second = await store.createUser(user('other@example.com'));
    await assert.rejects(store.updateUser(second._id, { email: 'PERSON@example.com' }), { status: 409 });
    assert.equal((await store.userById(second._id)).email, 'other@example.com');
    await store.updateUser(created._id, { disabled: true, role: 'admin' });
    const { users } = await store.listUsers({ query: 'PERSON' });
    assert.equal(users.length, 1);
    assert.equal(users[0].disabled, true);
    assert.equal(users[0].passwordHash, undefined);
    assert.equal(users[0].role, undefined);
    users[0].email = 'tampered';
    assert.equal((await store.userById(created._id)).email, 'person@example.com');
    const restarted = createLocalStore(filename);
    assert.equal((await restarted.userByEmail('PERSON@example.com')).passwordHash, original.passwordHash);
    assert.equal((await restarted.get('guest:legacy', id)).title, 'Existing report');
    assert.deepEqual(await restarted.adminOverview(), { userCount: 2, conversationCount: 1 });
});

test('sessions persist, honor expiry, and revoke only the selected account', async t => {
    const { store, filename } = await temporaryStore(t);
    const a = user('a@example.com');
    const b = user('b@example.com');
    await store.createUser(a);
    await store.createUser(b);
    const future = new Date(Date.now() + 60_000);
    await store.createSession({ hash: 'a-hash', userId: a._id, expiresAt: future });
    await assert.rejects(store.createSession({ hash: 'a-hash', userId: b._id, expiresAt: future }), { status: 409 });
    await store.createSession({ hash: 'b-hash', userId: b._id, expiresAt: future });
    await store.createSession({ hash: 'expired-hash', userId: a._id, expiresAt: new Date(Date.now() - 1000) });
    const restarted = createLocalStore(filename);
    assert.equal((await restarted.sessionByHash('a-hash')).userId, a._id);
    assert.equal(await restarted.sessionByHash('expired-hash'), null);
    assert.equal(await restarted.deleteUserSessions(a._id), 2);
    assert.equal(await restarted.sessionByHash('a-hash'), null);
    assert.equal((await restarted.sessionByHash('b-hash')).userId, b._id);
    assert.equal(await restarted.deleteSession('b-hash'), true);
    assert.equal(await restarted.deleteSession('b-hash'), false);
});

test('user and admin history pagination has no duplicates across equal timestamps', async t => {
    const { store } = await temporaryStore(t);
    const a = user('alpha@example.com');
    const b = user('beta@example.com');
    const c = user('charlie@example.com');
    for (const account of [a, b, c]) await store.createUser(account);
    const allUsers = [];
    let before = '';
    do {
        const page = await store.listUsers({ before, limit: 1 });
        allUsers.push(...page.users);
        before = page.next;
    } while (before);
    assert.equal(new Set(allUsers.map(account => account._id)).size, 3);
    assert.ok(allUsers.every(account => !('passwordHash' in account)));
    assert.equal((await store.listUsers({ query: '.*' })).users.length, 0);
    await assert.rejects(store.listUsers({ before: 'invalid' }), { status: 400 });

    const ids = [];
    for (const [index, owner] of ['user:' + a._id, 'user:' + a._id, 'user:' + b._id].entries()) {
        const id = randomUUID();
        ids.push(id);
        await store.create(owner, id);
        await store.lock(owner, id, 'run-' + index);
        await store.finish(owner, id, 'run-' + index, 'Research ' + index, [
            { role: 'user', text: index === 1 ? 'Find salary information' : 'Find jobs', mode: 'jobs' },
            { role: 'assistant', text: 'A response' }
        ]);
    }
    const found = await store.adminConversations({ owner: 'user:' + a._id, query: 'SALARY' });
    assert.equal(found.conversations.length, 1);
    assert.equal(found.conversations[0]._id, ids[1]);
    assert.equal(found.conversations[0].messageCount, 2);
    assert.equal(found.conversations[0].lastPrompt, 'Find salary information');
    assert.equal(found.conversations[0].kind, 'jobs');
    assert.equal(found.conversations[0].messages, undefined);
    assert.equal((await store.adminConversation(ids[2])).messages.length, 2);
    assert.equal(await store.get('user:' + a._id, ids[2]), null);
    const seen = [];
    before = '';
    do {
        const page = await store.adminConversations({ before, limit: 1 });
        seen.push(...page.conversations.map(chat => chat._id));
        before = page.next;
    } while (before);
    assert.equal(new Set(seen).size, 3);
    assert.deepEqual(await store.adminOverview(), { userCount: 3, conversationCount: 3 });
});

test('settings and bounded audit history survive restart', async t => {
    const oldAudit = Array.from({ length: 1000 }, (_, i) => ({
        _id: 'old-' + i, actor: 'owner', action: 'old', target: 'fixture', createdAt: '2000-01-01T00:00:00.000Z'
    }));
    const { store, filename } = await temporaryStore(t, { chats: {}, quotas: {}, audit: oldAudit });
    assert.deepEqual(await store.getSettings(), { registrationEnabled: true, researchEnabled: true });
    await store.saveSettings({ registrationEnabled: false, extra: 'ignored' });
    await assert.rejects(store.saveSettings({ researchEnabled: 'false' }), { status: 400 });
    const audit = await store.audit({ actor: 'owner', action: 'account.disabled', target: 'one',
        note: 'Reviewed account activity under the published terms.', details: { reason: 'terms' } });
    const restarted = createLocalStore(filename);
    assert.deepEqual(await restarted.getSettings(), { registrationEnabled: false, researchEnabled: true });
    assert.equal((await restarted.listAudit(1))[0]._id, audit._id);
    assert.equal((await restarted.listAudit(1))[0].note, 'Reviewed account activity under the published terms.');
    const disk = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(disk.audit.length, 1000);
    assert.equal(disk.audit.some(record => record._id === 'old-999'), false);
    const longNote = await restarted.audit({ actor: 'owner', action: 'research.requested', target: 'one', note: 'x'.repeat(5100) });
    assert.equal(longNote.note.length, 5000);
});

test('hosted account storage declares email uniqueness and session expiration indexes', () => {
    const mongoose = require('mongoose');
    assert.ok(mongoose.models.AtlasUser.schema.indexes().some(([fields, options]) => fields.email === 1 && options.unique));
    assert.ok(mongoose.models.AtlasSession.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
    assert.throws(() => createStore({ ATLAS_STORAGE: 'local', NODE_ENV: 'production' }), /Use MongoDB/);
});

test('authentication versions atomically invalidate credentials through password and status changes', async t => {
    const { store, filename } = await temporaryStore(t);
    const account = await store.createUser(user('version@example.com'));
    assert.equal(account.authVersion, 0);
    await store.createSession({ hash: 'old-session', userId: account._id, authVersion: 0, expiresAt: new Date(Date.now() + 60_000) });
    const bumped = await store.bumpUserAuth(account._id, { passwordHash: 'new-fixture-hash', role: 'admin', email: 'ignored@example.com' });
    assert.equal(bumped.authVersion, 1);
    assert.equal(bumped.passwordHash, 'new-fixture-hash');
    assert.equal(bumped.email, account.email);
    assert.equal(bumped.role, undefined);
    assert.equal((await store.sessionByHash('old-session')).authVersion, 0);
    const versions = await Promise.all([
        store.bumpUserAuth(account._id, { disabled: true }),
        store.bumpUserAuth(account._id, { disabled: false })
    ]);
    assert.deepEqual(versions.map(record => record.authVersion), [2, 3]);
    await store.updateUser(account._id, { authVersion: 100, name: 'Updated Name' });
    assert.equal((await store.userById(account._id)).authVersion, 3);
    await store.createSession({ hash: 'new-session', userId: account._id, authVersion: 3, expiresAt: new Date(Date.now() + 60_000) });
    const restarted = createLocalStore(filename);
    assert.equal((await restarted.userById(account._id)).authVersion, 3);
    assert.equal((await restarted.sessionByHash('new-session')).authVersion, 3);
    assert.equal((await restarted.listUsers()).users[0].authVersion, undefined);
    await assert.rejects(restarted.bumpUserAuth(account._id, { disabled: 'true' }), { status: 400 });
});
