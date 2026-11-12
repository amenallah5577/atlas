const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createLocalStore } = require('../atlas/local-store');
require('../atlas/store');

async function temporaryStore(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-oauth-storage-'));
    const filename = path.join(directory, 'store.json');
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('atlas-oauth-storage-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { filename, store: createLocalStore(filename) };
}
const hash = text => createHash('sha256').update(text).digest('hex');
const user = (email, extra = {}) => ({ _id: randomUUID(), email, name: 'Example', passwordHash: 'fixture-hash', ...extra });
const attempt = (extra = {}) => ({
    hash: hash(randomUUID()), browserHash: hash('browser'), provider: 'google', codeVerifier: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), acceptTerms: true, ...extra
});

test('social accounts persist without a password and private identities never enter account listings', async t => {
    const { store, filename } = await temporaryStore(t);
    const record = await store.createUser(user('social@example.com', {
        passwordHash: undefined, role: 'admin',
        identities: [{ provider: 'google', subject: 'verified-subject', key: 'untrusted-key', role: 'admin' }]
    }));
    assert.equal(record.passwordHash, undefined);
    assert.equal(record.role, undefined);
    assert.deepEqual(record.identities, [{ provider: 'google', subject: 'verified-subject', key: hash('google:verified-subject') }]);
    const restarted = createLocalStore(filename);
    assert.equal((await restarted.userByIdentity('google', 'verified-subject'))._id, record._id);
    assert.equal(await restarted.userByIdentity('github', 'verified-subject'), null);
    const listed = (await restarted.listUsers()).users[0];
    assert.equal(listed.identities, undefined);
    assert.equal(listed.passwordHash, undefined);
    await assert.rejects(store.createUser(user('locked-out@example.com', { passwordHash: undefined })), { status: 400 });
});

test('identity linkage is globally unique, idempotent, and limited to one identity per provider', async t => {
    const { store, filename } = await temporaryStore(t);
    const first = await store.createUser(user('first@example.com'));
    const second = await store.createUser(user('second@example.com'));
    const linked = await store.linkIdentity(first._id, 'google', 'one');
    assert.equal(linked.identities.length, 1);
    assert.equal((await store.linkIdentity(first._id, 'google', 'one')).identities.length, 1);
    await assert.rejects(store.linkIdentity(second._id, 'google', 'one'), { status: 409 });
    await assert.rejects(store.linkIdentity(first._id, 'google', 'two'), { status: 409 });
    await assert.rejects(store.createUser(user('duplicate@example.com', { identities: [{ provider: 'google', subject: 'one' }] })), { status: 409 });
    await store.linkIdentity(first._id, 'github', 'one');
    assert.equal((await store.userByIdentity('github', 'one'))._id, first._id);
    assert.equal((await store.linkIdentity(second._id, 'microsoft', 'one')).identities.length, 1);
    assert.equal(await store.linkIdentity('missing', 'google', 'three'), null);
    const restarted = createLocalStore(filename);
    assert.equal((await restarted.userById(first._id)).identities.length, 2);
    assert.equal((await restarted.userById(second._id)).identities.length, 1);
    await restarted.updateUser(first._id, { identities: [{ provider: 'google', subject: 'tampered' }] });
    assert.equal((await restarted.userByIdentity('google', 'one'))._id, first._id);
});

test('identity inputs reject unknown providers, unsafe subjects, and repeated providers', async t => {
    const { store } = await temporaryStore(t);
    for (const identities of [
        [{ provider: 'custom', subject: 'one' }],
        [{ provider: 'discord', subject: 'removed-provider' }],
        [{ provider: 'google', subject: { $gt: '' } }],
        [{ provider: 'google', subject: 'one\n' }],
        [{ provider: 'google', subject: 'one' }, { provider: 'google', subject: 'two' }]
    ]) await assert.rejects(store.createUser(user(randomUUID() + '@example.com', { identities })), { status: 400 });
    await assert.rejects(store.userByIdentity('google', ''), { status: 400 });
});

test('linking requires an active account and the authentication version captured before OAuth', async t => {
    const { store } = await temporaryStore(t);
    const account = await store.createUser(user('link-guard@example.com'));
    await store.linkIdentity(account._id, 'google', 'first', 0);
    await store.bumpUserAuth(account._id, { passwordHash: 'changed-password-hash' });
    assert.equal(await store.linkIdentity(account._id, 'github', 'stale-attempt', 0), null);
    assert.equal(await store.linkIdentity(account._id, 'google', 'first', 0), null);
    assert.equal(await store.userByIdentity('github', 'stale-attempt'), null);
    assert.equal((await store.linkIdentity(account._id, 'github', 'fresh-attempt', 1)).identities.length, 2);
    await store.bumpUserAuth(account._id, { disabled: true });
    assert.equal(await store.linkIdentity(account._id, 'microsoft', 'disabled-attempt', 2), null);
    assert.equal(await store.linkIdentity(account._id, 'google', 'first', 2), null);
    assert.equal(await store.linkIdentity(account._id, 'microsoft', 'disabled-attempt'), null);
    assert.equal(await store.userByIdentity('microsoft', 'disabled-attempt'), null);
    await assert.rejects(store.linkIdentity(account._id, 'microsoft', 'invalid-version', -1), { status: 400 });
});

test('OAuth attempts persist, bind to the browser and provider, and consume exactly once', async t => {
    const { store, filename } = await temporaryStore(t);
    const input = attempt({ userId: randomUUID(), authVersion: 3, extra: 'discarded' });
    const created = await store.createOAuthAttempt(input);
    assert.equal(created.extra, undefined);
    await assert.rejects(store.createOAuthAttempt(input), { status: 409 });
    const restarted = createLocalStore(filename);
    assert.equal(await restarted.consumeOAuthAttempt(input.hash, hash('other-browser'), 'google'), null);
    assert.equal(await restarted.consumeOAuthAttempt(input.hash, input.browserHash, 'github'), null);
    const consumed = await Promise.all([
        restarted.consumeOAuthAttempt(input.hash, input.browserHash, 'google'),
        restarted.consumeOAuthAttempt(input.hash, input.browserHash, 'google')
    ]);
    assert.equal(consumed.filter(Boolean).length, 1);
    assert.equal(consumed.find(Boolean).codeVerifier, input.codeVerifier);
    assert.equal(consumed.find(Boolean).userId, input.userId);
    assert.equal(consumed.find(Boolean).authVersion, 3);
    assert.equal(await createLocalStore(filename).consumeOAuthAttempt(input.hash, input.browserHash, 'google'), null);
});

test('expired OAuth attempts cannot be consumed and are pruned before new attempts', async t => {
    const { store, filename } = await temporaryStore(t);
    const expired = attempt({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await store.createOAuthAttempt(expired);
    assert.equal(await store.consumeOAuthAttempt(expired.hash, expired.browserHash, expired.provider), null);
    const fresh = attempt();
    await store.createOAuthAttempt(fresh);
    const disk = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(disk.oauthAttempts[expired.hash], undefined);
    assert.equal(Object.keys(disk.oauthAttempts).length, 1);
    for (const override of [
        { hash: 'raw-state' }, { browserHash: 'raw-cookie' }, { codeVerifier: 'short' },
        { expiresAt: 'invalid' }, { expiresAt: new Date(Date.now() + 3600_000) },
        { acceptTerms: 'true' }, { userId: 'one', authVersion: -1 }
    ]) await assert.rejects(store.createOAuthAttempt(attempt(override)), { status: 400 });
});

test('hosted storage declares unique identity and expiring OAuth-attempt indexes', () => {
    const mongoose = require('mongoose');
    assert.equal(mongoose.models.AtlasUser.schema.path('passwordHash').isRequired, undefined);
    assert.ok(mongoose.models.AtlasUser.schema.indexes().some(([fields, options]) =>
        fields['identities.key'] === 1 && options.unique && options.partialFilterExpression['identities.key'].$type === 'string'));
    assert.ok(mongoose.models.AtlasOAuthAttempt.schema.indexes().some(([fields, options]) =>
        fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});
