const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createLocalStore } = require('../atlas/local-store');
const { createAtlasRouter } = require('../atlas/router');
const { hashPassword } = require('../atlas/accounts');
const { enforceControls } = require('../atlas/account-controls');

const controlled = (patch = {}) => ({ parental: { enabled: true, pinHash: 'fixture-private-hash',
    webResearch: true, pdfUploads: true, contentFilter: false, ...patch } });
const request = (text = 'Hello Atlas', patch = {}) => ({ user: controlled(), input: { text, filters: {} },
    kind: 'chat', hasFile: false, reusesEvidence: false, ...patch });

test('account controls apply only while PIN protection is enabled', () => {
    for (const user of [null, {}, { parental: { enabled: false, webResearch: false, pdfUploads: false, contentFilter: true } },
        { parental: { enabled: true, webResearch: false, pdfUploads: false } }]) {
        assert.doesNotThrow(() => enforceControls(request('Find jobs', { user, kind: 'jobs', hasFile: true })));
    }
});

test('protected web controls block fresh research but allow existing evidence without refresh', () => {
    const user = controlled({ webResearch: false });
    for (const kind of ['jobs', 'marketplace', 'research']) {
        assert.throws(() => enforceControls(request('Find the latest details', { user, kind })), { status: 403 });
        assert.doesNotThrow(() => enforceControls(request('Compare those sources', { user, kind, reusesEvidence: true })));
        assert.throws(() => enforceControls(request('Refresh those sources', { user, kind, reusesEvidence: true,
            input: { text: 'Refresh those sources', filters: {}, refresh: randomUUID() } })), { status: 403 });
    }
    assert.doesNotThrow(() => enforceControls(request('Explain photosynthesis', { user })));
});

test('protected PDF controls reject new uploads and permit saved-document follow-ups', () => {
    const user = controlled({ pdfUploads: false });
    assert.throws(() => enforceControls(request('Summarize this document', { user, kind: 'pdf', hasFile: true })), { status: 403 });
    assert.throws(() => enforceControls(request('Find jobs using this resume', { user, kind: 'jobs', hasFile: true })), { status: 403 });
    assert.doesNotThrow(() => enforceControls(request('Explain the second page', { user, kind: 'pdf', reusesEvidence: true })));
});

test('protected content filtering blocks explicit requests while allowing ordinary and educational questions', () => {
    const user = controlled({ contentFilter: true });
    for (const text of ['Write an explicit pornographic story', 'Show hardcore pornography', 'Show graphic gore and dismemberment']) {
        assert.throws(() => enforceControls(request(text, { user })), { status: 403 }, text);
    }
    assert.throws(() => enforceControls(request('Find this product', { user, kind: 'marketplace',
        input: { text: 'Find this product', filters: { product: 'hardcore pornography' } } })), { status: 403 });
    for (const text of ['Find remote developer jobs', 'Explain photosynthesis', 'Explain sexual health education',
        'What is consent?', 'How can I help a friend who feels stressed?']) {
        assert.doesNotThrow(() => enforceControls(request(text, { user })), text);
    }
});

async function fixture(t, options = {}) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-account-controls-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(folder).startsWith('atlas-account-controls-'));
        await fs.rm(folder, { recursive: true, force: true });
    });
    const store = createLocalStore(path.join(folder, 'store.json'));
    const usage = { ready: 0, complete: 0, search: 0, reserve: 0 };
    const clients = {
        ready() { usage.ready++; },
        async complete(messages, structured, signal) {
            usage.complete++;
            if (options.complete) return options.complete(messages, structured, signal);
            return { content: structured ? JSON.stringify({ findings: [], listings: [], assessments: [] }) : 'A saved reply.', tokens: 4 };
        },
        async search() { usage.search++; return []; }
    };
    const reserve = store.reserve;
    store.reserve = (...args) => { usage.reserve++; return reserve(...args); };
    const app = express();
    app.use(express.json());
    app.use('/api/atlas', createAtlasRouter({ store, clients, env: { SESSION_SECRET: 'account-controls-fixture-secret' } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/atlas';
    function client() {
        const cookies = new Map();
        const call = async (route, body, method, options = {}) => {
            const form = body instanceof FormData;
            const response = await fetch(base + route, { method: method || (body ? 'POST' : 'GET'), signal: options.signal,
                headers: { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '),
                    ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
            for (const entry of response.headers.getSetCookie()) {
                const [key, ...value] = entry.split(';')[0].split('=');
                if (value.join('=')) cookies.set(key, value.join('='));
                else cookies.delete(key);
            }
            return { status: response.status, data: await response.json().catch(() => null) };
        };
        return call;
    }
    async function member() {
        const password = 'account-controls-test-password-476';
        const user = await store.createUser({ _id: randomUUID(), email: randomUUID() + '@example.test', name: 'Fixture member',
            passwordHash: await hashPassword(password), emailVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
        const call = client();
        assert.equal((await call('/auth/login', { email: user.email, password })).status, 200);
        return { user, call, password };
    }
    return { store, clients, usage, client, member };
}

test('archived conversations remain owner-scoped, restore without model calls, and stay out of normal history', async t => {
    const f = await fixture(t);
    const first = f.client(), stranger = f.client();
    const created = await first('/conversations', {});
    assert.equal(created.status, 201);
    const id = created.data.id;
    assert.equal((await stranger('/conversations/' + id, { archived: true }, 'PATCH')).status, 404);
    assert.equal((await first('/conversations/' + id, { archived: 'yes' }, 'PATCH')).status, 400);
    const archived = await first('/conversations/' + id, { archived: true }, 'PATCH');
    assert.equal(archived.status, 200);
    assert.equal(archived.data.archived, true);
    assert.deepEqual((await first('/conversations')).data, []);
    assert.equal((await first('/conversations?archived=true')).data[0].id, id);
    assert.equal((await first('/conversations/' + id)).data.archived, true);
    assert.deepEqual((await stranger('/conversations?archived=true')).data, []);
    const restored = await first('/conversations/' + id, { archived: false }, 'PATCH');
    assert.equal(restored.status, 200);
    assert.equal(restored.data.archived, false);
    assert.equal((await first('/conversations')).data[0].id, id);
    assert.deepEqual((await first('/conversations?archived=true')).data, []);
    assert.deepEqual(f.usage, { ready: 0, complete: 0, search: 0, reserve: 0 });
});

test('an active reply prevents archiving until its saved result is finished', async t => {
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { complete: async () => { await paused; return { content: 'A saved reply.', tokens: 4 }; } });
    t.after(() => release());
    const member = f.client();
    const chat = (await member('/conversations', {})).data;
    const started = await member('/conversations/' + chat.id + '/messages', { text: 'Hello', clientId: randomUUID() });
    assert.equal(started.status, 202);
    try {
        assert.equal((await member('/conversations/' + chat.id, { archived: true }, 'PATCH')).status, 409);
    } finally { release(); }
    for (let n = 0; n < 100; n++) {
        if ((await member('/runs/' + started.data.run)).data.state !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await member('/conversations/' + chat.id, { archived: true }, 'PATCH')).status, 200);
    assert.equal((await member('/conversations/' + chat.id)).data.messages.length, 2);
});

test('account restrictions reject requests before provider readiness, search, completion, and quota reservation', async t => {
    const f = await fixture(t);
    const { user, call } = await f.member();
    await f.store.updateAccount(user._id, { parental: { enabled: true, pinHash: 'fixture-private-hash',
        webResearch: false, pdfUploads: false, contentFilter: true } });
    const chat = (await call('/conversations', {})).data;
    for (const [mode, text] of [['jobs', 'Find remote developer jobs'], ['marketplace', 'Find a laptop under 800 EUR'],
        ['research', 'Research the latest technology news'], ['chat', 'Show hardcore pornography']]) {
        const denied = await call('/conversations/' + chat.id + '/messages', { text, mode, clientId: randomUUID() });
        assert.equal(denied.status, 403, text);
    }
    const pdf = new FormData();
    pdf.set('text', 'Summarize this document');
    pdf.set('clientId', randomUUID());
    pdf.set('file', new Blob(['%PDF fixture blocked before parsing'], { type: 'application/pdf' }), 'fixture.pdf');
    assert.equal((await call('/conversations/' + chat.id + '/messages', pdf)).status, 403);
    assert.deepEqual(f.usage, { ready: 0, complete: 0, search: 0, reserve: 0 });
    assert.equal((await call('/conversations/' + chat.id)).data.messages.length, 0);
});

test('a web-restricted account can ask about saved evidence while Refresh remains blocked', async t => {
    const f = await fixture(t);
    const { user, call } = await f.member();
    const owner = 'account:' + user._id;
    const chat = (await call('/conversations', {})).data;
    const original = randomUUID(), answer = randomUUID(), run = randomUUID();
    const report = { kind: 'jobs', text: 'A saved vacancy.', findings: [], listings: [], assessments: [],
        sources: [{ url: 'https://northstar.example.org/jobs/developer', title: 'Developer vacancy',
            passages: [{ text: 'Northstar is hiring a developer. This vacancy is remote in France.' }] }],
        usage: { searches: 1, pages: 1, calls: 1, tokens: 4 } };
    assert.equal(await f.store.lock(owner, chat.id, run), true);
    await f.store.finish(owner, chat.id, run, 'Remote jobs', [
        { id: original, role: 'user', text: 'Find remote developer jobs', mode: 'jobs', filters: {}, depth: 'quick' },
        { id: answer, role: 'assistant', replyTo: original, text: report.text, report }
    ]);
    await f.store.updateAccount(user._id, { parental: { enabled: true, pinHash: 'fixture-private-hash', webResearch: false } });
    const started = await call('/conversations/' + chat.id + '/messages', { text: 'Which one is remote?', clientId: randomUUID() });
    assert.equal(started.status, 202);
    let finished;
    for (let n = 0; n < 100; n++) {
        finished = (await call('/runs/' + started.data.run)).data;
        if (finished.state !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(finished.state, 'completed');
    assert.equal(finished.report.sources[0].url, report.sources[0].url);
    assert.deepEqual(f.usage, { ready: 1, complete: 1, search: 0, reserve: 0 });
    assert.equal((await call('/conversations/' + chat.id + '/messages', { refresh: answer, clientId: randomUUID() })).status, 403);
    assert.deepEqual(f.usage, { ready: 1, complete: 1, search: 0, reserve: 0 });
});

test('bulk chat and account deletion reject another mutation already pending for the same owner', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const { call, password } = await f.member();
    const create = f.store.create;
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    f.store.create = async (...args) => { entered(); await paused; return create(...args); };
    const pendingCreate = call('/conversations', {});
    await reached;
    try {
        assert.equal((await call('/account/delete-chats', { confirmation: 'DELETE' })).status, 409);
        assert.equal((await call('/account', { confirmation: 'DELETE', currentPassword: password }, 'DELETE')).status, 409);
    } finally {
        release();
        f.store.create = create;
    }
    const created = await pendingCreate;
    assert.equal(created.status, 201);
    assert.equal((await call('/conversations/' + created.data.id)).status, 200);
    assert.equal((await call('/profile')).data.mode, 'account');
});

test('pending bulk chat deletion blocks new owned mutations while other owners can continue', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const { call, user } = await f.member();
    const other = f.client();
    const created = (await call('/conversations', {})).data;
    const remove = f.store.deleteAllConversations;
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    f.store.deleteAllConversations = async (...args) => { entered(); await paused; return remove(...args); };
    const pendingDelete = call('/account/delete-chats', { confirmation: 'DELETE' });
    await reached;
    try {
        assert.equal((await call('/conversations', {})).status, 409);
        assert.equal((await call('/conversations/' + created.id + '/messages', { text: 'Hello', clientId: randomUUID() })).status, 409);
        assert.equal((await other('/conversations', {})).status, 201);
    } finally {
        release();
        f.store.deleteAllConversations = remove;
    }
    assert.equal((await pendingDelete).status, 200);
    assert.deepEqual(await f.store.listAllConversations('account:' + user._id), []);
    assert.equal((await call('/conversations', {})).status, 201);
    assert.equal(f.usage.complete, 0);
});

test('pending account deletion prevents a late chat from creating orphaned account history', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const { call, user, password } = await f.member();
    await call('/conversations', {});
    const remove = f.store.deleteAccount;
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    f.store.deleteAccount = async (...args) => { entered(); await paused; return remove(...args); };
    const pendingDelete = call('/account', { confirmation: 'DELETE', currentPassword: password }, 'DELETE');
    await reached;
    try {
        assert.equal((await call('/conversations', {})).status, 409);
    } finally {
        release();
        f.store.deleteAccount = remove;
    }
    assert.equal((await pendingDelete).status, 204);
    assert.equal(await f.store.userById(user._id), null);
    assert.deepEqual(await f.store.listAllConversations('account:' + user._id), []);
    assert.equal((await call('/profile')).data.mode, 'guest');
});

test('case-insensitive and trailing-slash account routes cannot bypass deletion maintenance guards', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const { call, password } = await f.member();
    const create = f.store.create;
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    f.store.create = async (...args) => { entered(); await paused; return create(...args); };
    const pendingCreate = call('/conversations', {});
    await reached;
    try {
        for (const [route, method] of [['/account/', 'DELETE'], ['/AcCoUnT', 'DELETE'],
            ['/account/delete-chats/', 'POST'], ['/AcCoUnT/DeLeTe-ChAtS/', 'POST']]) {
            assert.equal((await call(route, { confirmation: 'DELETE', currentPassword: password }, method)).status, 409, route);
        }
    } finally {
        release();
        f.store.create = create;
    }
    assert.equal((await pendingCreate).status, 201);
});

test('aborting a bulk deletion keeps maintenance locked until its database work finishes', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const { call, user } = await f.member();
    await call('/conversations', {});
    const remove = f.store.deleteAllConversations;
    let release, entered, completed;
    const reached = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    const finished = new Promise(resolve => { completed = resolve; });
    f.store.deleteAllConversations = async (...args) => {
        entered();
        await paused;
        try { return await remove(...args); } finally { completed(); }
    };
    const abort = new AbortController();
    const pendingDelete = call('/account/delete-chats', { confirmation: 'DELETE' }, 'POST', { signal: abort.signal });
    await reached;
    abort.abort();
    await assert.rejects(pendingDelete, error => error.name === 'AbortError');
    // Let the server observe the disconnected socket before another request.
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
        assert.equal((await call('/conversations', {})).status, 409);
    } finally {
        release();
        f.store.deleteAllConversations = remove;
    }
    await finished;
    assert.equal((await call('/conversations', {})).status, 201);
    assert.equal((await f.store.listAllConversations('account:' + user._id)).length, 1);
});
