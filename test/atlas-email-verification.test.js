const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { createAtlasRouter } = require('../atlas/router');
const { createLocalStore } = require('../atlas/local-store');
const { hashPassword } = require('../atlas/accounts');
const { createEmailDelivery, validEmail, verifyDomain } = require('../atlas/email-delivery');
const { emailFixture } = require('../test-support/email');
const password = 'email-verification-test-password-42';

async function fixture(t, production = false) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-email-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const filename = path.join(folder, 'store.json'), store = createLocalStore(filename), delivery = emailFixture();
    let now = Date.now();
    const env = { SESSION_SECRET: 'verification-secret-with-at-least-32-bytes', ATLAS_OWNER_EMAIL: 'owner@example.test', ATLAS_OWNER_ID: randomUUID(), ...(production ? { NODE_ENV: 'production' } : {}) };
    const app = express(); app.use(express.json());
    app.use('/api/atlas', createAtlasRouter({ store, env, emailDelivery: delivery, verificationClock: () => new Date(now), clients: { ready() {} } }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/atlas';
    function client() {
        const cookies = new Map();
        return async (url, body, headers = {}) => {
            const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), ...headers },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const setCookies = response.headers.getSetCookie();
            for (const cookie of setCookies) { const pair = cookie.split(';')[0], offset = pair.indexOf('='); cookies.set(pair.slice(0, offset), pair.slice(offset + 1)); }
            return { status: response.status, data: await response.json().catch(() => null), setCookies };
        };
    }
    const register = (call, email = 'person@example.test') => call('/auth/register', { email, password, name: 'Person', acceptTerms: true });
    const confirm = (call, pending, code = delivery.sent.get(pending.email).code) => call('/auth/verification/confirm', { verificationId: pending.id, code });
    return { client, store, delivery, register, confirm, env, filename, advance: milliseconds => { now += milliseconds; } };
}

test('signup activates only after an inbox code, stores no plaintext password/code, and restores verified identity', async t => {
    const f = await fixture(t, true), call = f.client();
    const start = await f.register(call, 'Person@Example.test'), pending = start.data.verification;
    assert.equal(start.status, 202); assert.equal(pending.email, 'person@example.test'); assert(!start.data.user);
    assert(!start.setCookies.some(cookie => cookie.startsWith('__Host-atlas_auth=')));
    assert(start.setCookies.some(cookie => cookie.startsWith('__Host-atlas_verify=') && /Secure/.test(cookie) && /HttpOnly/.test(cookie)));
    assert.equal(await f.store.userByEmail(pending.email), null); assert.equal((await call('/profile')).data.mode, 'guest');
    const disk = await fs.readFile(f.filename, 'utf8'); assert(!disk.includes(password)); assert(!disk.includes('"code":'));
    assert(!JSON.stringify(start.data).includes(f.delivery.sent.get(pending.email).code));
    const finished = await f.confirm(call, pending);
    assert.equal(finished.status, 201); assert.equal(finished.data.user.emailVerified, true);
    assert(finished.setCookies.some(cookie => cookie.startsWith('__Host-atlas_auth=') && /Secure/.test(cookie)));
    assert.equal((await call('/profile')).data.mode, 'account');
    const restored = await createLocalStore(f.filename).userByEmail(pending.email); assert(restored.emailVerifiedAt); assert(restored.passwordHash.startsWith('scrypt$'));
    assert.equal((await f.confirm(call, pending)).status, 400);
});

test('verification is browser-bound, limits guesses, and expires before physical cleanup', async t => {
    const f = await fixture(t), call = f.client(), other = f.client();
    const pending = (await f.register(call)).data.verification;
    assert.equal((await f.confirm(other, pending)).status, 400);
    assert.equal((await other('/auth/verification')).data.verification, null);
    for (let i = 0; i < 5; i++) assert.equal((await f.confirm(call, pending, '000000')).status, 400);
    assert.equal((await f.confirm(call, pending)).status, 400); assert.equal(await f.store.userByEmail(pending.email), null);
    const second = (await f.register(other, 'second@example.test')).data.verification;
    f.advance(10 * 60_000 + 1);
    assert.equal((await other('/auth/verification')).data.verification, null);
    assert.equal((await f.confirm(other, second)).status, 400);
});

test('resend enforces cooldown, replaces old codes, and pending signup survives reload', async t => {
    const f = await fixture(t), call = f.client();
    const first = (await f.register(call)).data.verification, oldCode = f.delivery.sent.get('person@example.test').code;
    assert.equal((await call('/auth/verification/resend', { verificationId: first.id })).status, 429);
    f.advance(60_001);
    const resent = await call('/auth/verification/resend', { verificationId: first.id }); assert.equal(resent.status, 202);
    const saved = (await call('/auth/verification')).data.verification;
    assert.equal(saved.id, resent.data.verification.id); assert.notEqual(saved.id, first.id);
    assert.equal((await f.confirm(call, first, oldCode)).status, 400);
    assert.equal((await f.confirm(call, saved)).status, 201);
});

test('concurrent correct-code submissions consume a verification once', async t => {
    const f = await fixture(t), call = f.client(), pending = (await f.register(call)).data.verification;
    const results = await Promise.all([f.confirm(call, pending), f.confirm(call, pending)]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 400]);
    assert.equal((await f.store.listUsers({})).users.length, 1);
});

test('legacy accounts require password and inbox proof, preserve ownership, and reject revoked pending logins', async t => {
    const f = await fixture(t), call = f.client();
    const user = await f.store.createUser({ _id: f.env.ATLAS_OWNER_ID, email: f.env.ATLAS_OWNER_EMAIL, passwordHash: await hashPassword(password) });
    const chat = await f.store.create('account:' + user._id, randomUUID());
    assert.equal((await call('/auth/login', { email: user.email, password: 'wrong-password-42' })).status, 401); assert.equal(f.delivery.sent.size, 0);
    const login = await call('/auth/login', { email: user.email, password }); assert.equal(login.status, 202);
    const done = await f.confirm(call, login.data.verification); assert.equal(done.status, 200); assert.equal(done.data.user.isAdmin, true);
    assert.equal(done.data.user.id, user._id); assert(await f.store.get('account:' + user._id, chat._id));
    assert.equal((await call('/auth/login', { email: user.email, password })).status, 200);
    const old = await f.store.createUser({ _id: randomUUID(), email: 'old@example.test', passwordHash: await hashPassword(password) });
    const pending = (await call('/auth/login', { email: old.email, password })).data.verification;
    await f.store.bumpUserAuth(old._id, { disabled: true }); assert.equal((await f.confirm(call, pending)).status, 401);
});

test('failed delivery, free quotas and paused registration never activate an account', async t => {
    const f = await fixture(t), call = f.client();
    f.delivery.send = async () => { throw new Error('private provider response'); };
    const failed = await f.register(call); assert.equal(failed.status, 503); assert(!JSON.stringify(failed.data).includes('private'));
    assert.equal(await f.store.userByEmail('person@example.test'), null);
    assert.deepEqual(JSON.parse(await fs.readFile(f.filename, 'utf8')).emailVerifications, {});
    f.delivery.send = async message => f.delivery.sent.set(message.email, message);
    await f.store.reserve('email-free', 'day', 259, 260); assert.equal((await f.register(call)).status, 429); assert.equal(f.delivery.sent.size, 0);
    await f.store.saveSettings({ registrationEnabled: false }); assert.equal((await f.register(call, 'another@example.test')).status, 403);
});

test('email validation rejects malformed addresses, missing mail domains and explicit null MX', async () => {
    for (const address of ['bad', 'a..b@gmail.com', '.name@gmail.com', 'x@-bad.com', 'x@gmail.com\r\nBcc:x@test.com']) assert.equal(validEmail(address), false);
    assert(validEmail('person+atlas@gmail.com'));
    await assert.rejects(verifyDomain('nobody@example.invalid'), { status: 400 });
    await assert.rejects(verifyDomain('nobody@example.org', { resolveMx: async () => [{ exchange: '.', priority: 0 }] }), { status: 400 });
    const missing = async () => { throw Object.assign(new Error('no records'), { code: 'ENOTFOUND' }); };
    await assert.rejects(verifyDomain('nobody@example.org', { resolveMx: missing, resolve4: missing, resolve6: missing }), { status: 400 });
    await verifyDomain('person@example.org', { resolveMx: async () => [{ exchange: 'mail.example.org' }] });
});

test('Brevo delivery requires a free plan and verified sender, with no paid fallback', async () => {
    const env = { ATLAS_EMAIL_PROVIDER: 'brevo', ATLAS_EMAIL_FROM: 'owner@example.org', ATLAS_BREVO_API_KEY: 'fixture', ATLAS_EMAIL_FREE_PLAN_CONFIRMED: 'true' }, requests = [];
    const delivery = createEmailDelivery(env, async (url, options) => {
        requests.push({ url, options }); return { ok: true, json: async () => url.endsWith('/account') ? { plan: [{ type: 'free' }] } : url.endsWith('/senders') ?
            { senders: [{ email: env.ATLAS_EMAIL_FROM, active: true }] } : { messageId: 'accepted' } };
    });
    await delivery.send({ email: 'recipient@example.org', code: '123456', id: 'fixture-id' });
    assert.equal(requests.length, 3); assert.equal(requests.at(-1).url, 'https://api.brevo.com/v3/smtp/email');
    const body = JSON.parse(requests.at(-1).options.body); assert.match(body.textContent, /123456/); assert.equal(body.to[0].email, 'recipient@example.org');
    const paid = createEmailDelivery(env, async () => ({ ok: true, json: async () => ({ plan: [{ type: 'subscription' }] }) }));
    await assert.rejects(paid.send({}), { status: 503 });
    const unverified = createEmailDelivery(env, async url => ({ ok: true, json: async () => url.endsWith('/account') ? { plan: [{ type: 'free' }] } : { senders: [] } }));
    await assert.rejects(unverified.send({}), { status: 503 }); assert.throws(() => createEmailDelivery({}).ready(), { status: 503 });
});

test('MongoDB verification storage declares expiry and unique challenge indexes', () => {
    require('../atlas/store'); const model = require('mongoose').models.AtlasEmailVerification;
    assert(model.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
    assert(model.schema.indexes().some(([fields, options]) => fields.id === 1 && options.unique === true));
});

test('embedded same-origin signup is allowed while opaque and cross-site requests remain blocked', async t => {
    const f = await fixture(t), call = f.client();
    const body = { email: 'embedded@example.test', password, acceptTerms: true };
    assert.equal((await call('/auth/register', body, { Origin: 'null' })).status, 403);
    assert.equal((await call('/auth/register', body, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call('/auth/register', body, { Origin: 'https://unrelated.example', 'Sec-Fetch-Site': 'same-origin' })).status, 403);
    assert.equal((await call('/auth/register', body, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status, 202);
});
