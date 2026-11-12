const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { configureDeployment, startServer } = require('../lib/deployment');

function production(overrides = {}) {
    return { NODE_ENV: 'production', ATLAS_STANDALONE: 'true', ATLAS_STORAGE: 'mongodb',
        MONGODB_URI: 'mongodb://database.invalid/atlas', SESSION_SECRET: 'fixture-secret-'.repeat(3),
        RENDER_EXTERNAL_URL: 'https://atlas.example.org', ATLAS_LLM_PROVIDER: 'groq',
        ATLAS_GROQ_API_KEY: 'fixture', ATLAS_TAVILY_API_KEY: 'fixture',
        ATLAS_FREE_PROVIDERS_CONFIRMED: 'true', ...overrides };
}

test('dedicated production refuses ephemeral storage, weak secrets, unsafe origins, and unconfirmed providers', () => {
    for (const patch of [{ ATLAS_STORAGE: 'local' }, { MONGODB_URI: '' }, { SESSION_SECRET: 'short' },
        { ATLAS_PUBLIC_URL: 'http://atlas.example.org' }, { ATLAS_PUBLIC_URL: 'https://user:password@atlas.example.org' },
        { ATLAS_PUBLIC_URL: 'https://atlas.example.org/path' }, { ATLAS_GROQ_API_KEY: '' },
        { ATLAS_TAVILY_API_KEY: '' }, { ATLAS_FREE_PROVIDERS_CONFIRMED: 'false' }]) {
        assert.throws(() => configureDeployment(express(), { env: production(patch) }));
    }
    const env = production();
    const app = express();
    configureDeployment(app, { env });
    assert.equal(env.ATLAS_PUBLIC_URL, 'https://atlas.example.org');
    assert.throws(() => configureDeployment(express(), { env: { ATLAS_TRUST_PROXY: 'true' } }));
});

test('health checks verify storage without sessions or provider quota and hide database errors', async t => {
    let pings = 0, fail = false;
    const database = { connection: { readyState: 0, db: { async command(value) {
        pings++; assert.deepEqual(value, { ping: 1 });
        if (fail) throw new Error('mongodb://private:password@database.invalid');
    } } } };
    const app = express();
    const state = configureDeployment(app, { database, env: {} });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/healthz';
    assert.equal((await fetch(endpoint)).status, 503);
    assert.equal(pings, 0);
    database.connection.readyState = 1;
    const ready = await fetch(endpoint);
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get('set-cookie'), null);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ready.json(), { status: 'ok', storage: 'mongodb' });
    fail = true;
    const failed = await fetch(endpoint);
    assert.equal(failed.status, 503);
    assert.equal((await failed.text()).includes('password'), false);
    state.draining = true;
    assert.equal((await fetch(endpoint)).status, 503);
    assert.equal(pings, 2);
});

test('startup initializes persistent indexes before listening and shutdown saves active work before disconnecting', async () => {
    const order = [], app = express(), state = { draining: false };
    const database = { connection: {}, models: { user: { async init() { order.push('indexes'); } } },
        async connect() { order.push('connected'); }, async disconnect() { order.push('disconnected'); } };
    const server = await startServer(app, { env: { PORT: '0', MONGODB_URI: 'mongodb://fixture' }, database, state,
        beforeClose: async () => { assert.equal(state.draining, true); order.push('saved'); } });
    assert.deepEqual(order, ['connected', 'indexes']);
    assert.ok(server.address().port > 0);
    const closing = server.shutdown();
    assert.equal(server.shutdown(), closing);
    await closing;
    assert.deepEqual(order, ['connected', 'indexes', 'saved', 'disconnected']);
    assert.equal(server.listening, false);
});

test('database startup failure never opens a public listener or prints credentials', async () => {
    let opened = false, disconnected = false;
    const app = { listen() { opened = true; } };
    const database = { models: {}, async connect() { throw new Error('private-database-password'); },
        async disconnect() { disconnected = true; } };
    await assert.rejects(startServer(app, { env: { MONGODB_URI: 'mongodb://fixture' }, database }), error => {
        assert.match(error.message, /MongoDB startup failed/);
        assert.equal(error.message.includes('private-database-password'), false);
        return true;
    });
    assert.equal(opened, false);
    assert.equal(disconnected, true);
});

test('dedicated Atlas homepage and legacy EchoSphere homepage remain selectable independently', async () => {
    const { spawn } = require('node:child_process');
    for (const standalone of ['true', 'false']) {
        const child = spawn(process.execPath, ['-e', "const app=require('./server');const server=app.listen(0,'127.0.0.1',()=>console.log('ATLAS_TEST_PORT:'+server.address().port));"], {
            cwd: require('node:path').resolve(__dirname, '..'),
            env: { ...process.env, NODE_ENV: 'test', ATLAS_STANDALONE: standalone, ATLAS_STORAGE: 'local', MONGODB_URI: '', SESSION_SECRET: 'fixture'.repeat(8) },
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        });
        try {
            const port = await new Promise((resolve, reject) => {
                let output = '';
                const timeout = setTimeout(() => reject(new Error('Homepage server did not start')), 15_000);
                child.stdout.on('data', chunk => {
                    output += chunk;
                    const match = output.match(/ATLAS_TEST_PORT:(\d+)/);
                    if (match) { clearTimeout(timeout); resolve(match[1]); }
                });
                child.once('exit', () => { clearTimeout(timeout); reject(new Error('Homepage server exited before listening')); });
            });
            const root = await (await fetch('http://127.0.0.1:' + port)).text();
            assert.equal(root.includes('<title>Atlas · EchoSphere</title>'), standalone === 'true');
            const atlas = await (await fetch('http://127.0.0.1:' + port + '/atlas')).text();
            assert.ok(atlas.includes('<title>Atlas · EchoSphere</title>'));
        } finally {
            child.kill();
            await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
        }
    }
});

test('shutdown cancels an active model request, releases its conversation lock, and rejects new runs', async t => {
    const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
    const { randomUUID } = require('node:crypto');
    const { createLocalStore } = require('../atlas/local-store');
    const { createAtlasRouter } = require('../atlas/router');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-drain-'));
    const filename = path.join(directory, 'store.json'), store = createLocalStore(filename);
    t.after(async () => { await fs.unlink(filename); await fs.rmdir(directory); });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const clients = { ready() {}, complete(messages, structured, signal) {
        entered();
        return new Promise((resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
    } };
    const app = express(); app.use(express.json());
    const router = createAtlasRouter({ store, clients, env: { SESSION_SECRET: 'fixture' } });
    app.use('/api/atlas', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    let cookie = '';
    async function api(route, body) {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/atlas' + route, {
            method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        return { status: response.status, data: await response.json() };
    }
    const chat = (await api('/conversations', {})).data;
    const run = (await api('/conversations/' + chat.id + '/messages', { text: 'Explain closures', clientId: randomUUID() })).data.run;
    await started;
    await router.shutdown();
    const stopped = (await api('/runs/' + run)).data;
    assert.equal(stopped.state, 'failed');
    assert.match(stopped.error, /restarting/);
    const rejected = await api('/conversations/' + chat.id + '/messages', { text: 'Try another reply', clientId: randomUUID() });
    assert.equal(rejected.status, 503);
    assert.equal((await api('/conversations/' + chat.id)).data.run, null);
});
