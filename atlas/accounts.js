const express = require('express');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { rateLimit } = require('express-rate-limit');
const { AtlasError } = require('./research');
const { createSocialAuth } = require('./social-auth');
const { createAccountSettings } = require('./account-settings');
const { createEmailVerification } = require('./email-verification');

const scrypt = promisify(crypto.scrypt);
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const TERMS_VERSION = '2026-11-11';
const publicUser = (user, ownerId) => ({
    id: user._id, email: user.email, name: user.name || '', isAdmin: user._id === ownerId,
    hasPassword: Boolean(user.passwordHash), providers: [...new Set((user.identities || []).map(identity => identity.provider))],
    avatarUrl: user.avatarUrl || '', createdAt: user.createdAt, emailVerified: Boolean(user.emailVerifiedAt)
});

async function hashPassword(password) {
    const salt = crypto.randomBytes(24).toString('hex');
    const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return 'scrypt$' + salt + '$' + hash.toString('hex');
}
async function verifyPassword(password, encoded) {
    const [, salt, expected] = String(encoded || '').split('$');
    if (!salt || !/^[a-f0-9]{128}$/.test(expected || '')) return false;
    const actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
        throw new AtlasError(400, 'Use a password between 12 and 128 characters.');
    }
}
function cookieToken(req, name) {
    const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}

function createAccounts({ store, env, providers, emailDelivery, verificationClock }) {
    const router = express.Router();
    const ownerId = env.ATLAS_OWNER_ID;
    const verification = createEmailVerification({ store, env, delivery: emailDelivery, clock: verificationClock });
    const cookieName = env.NODE_ENV === 'production' ? '__Host-atlas_auth' : 'atlas_auth';
    const cookieOptions = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/' };
    const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res))
        .catch(next).finally(() => req.atlasMutationDone?.());
    let passwordJobs = 0;
    const dummyHash = hashPassword(crypto.randomBytes(32).toString('hex'));
    const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
        message: { error: 'Too many account attempts. Try again in 15 minutes.' } });
    router.use(limiter);
    router.use(express.json({ limit: '8kb' }));

    async function current(req) {
        const token = cookieToken(req, cookieName);
        if (!token || !store.sessionByHash) return null;
        store.ready();
        const session = await store.sessionByHash(hashToken(token));
        if (!session) return null;
        const user = await store.userById(session.userId);
        if (!user || user.disabled || (session.authVersion || 0) !== (user.authVersion || 0)) return null;
        req.authSession = session;
        return user;
    }
    async function attach(req) {
        req.account = await current(req);
        if (req.account) req.profile = { mode: 'account', ownerId: 'account:' + req.account._id };
    }
    async function issue(req, res, user) {
        const existing = cookieToken(req, cookieName);
        if (existing) await store.deleteSession(hashToken(existing));
        const token = crypto.randomBytes(32).toString('hex');
        const lifetime = user._id === ownerId ? 12 * 60 * 60_000 : 7 * 86400_000;
        await store.createSession({ hash: hashToken(token), userId: user._id, authVersion: user.authVersion || 0,
            createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + lifetime).toISOString() });
        const latest = await store.userById(user._id);
        if (!latest || latest.disabled || (latest.authVersion || 0) !== (user.authVersion || 0)) {
            await store.deleteSession(hashToken(token));
            throw new AtlasError(401, 'Account access changed. Sign in again.');
        }
        res.cookie(cookieName, token, { ...cookieOptions, maxAge: lifetime });
    }
    function requireAccount(req) {
        if (!req.account) throw new AtlasError(401, 'Sign in to continue.');
        return req.account;
    }
    function requireOwner(req) {
        const user = requireAccount(req);
        if (!ownerId || user._id !== ownerId) throw new AtlasError(403, 'Only the site owner can access administration.');
        return user;
    }
    function passwordWork(handler) {
        return route(async (req, res) => {
            if (passwordJobs >= 2) throw new AtlasError(429, 'Account access is busy. Try again shortly.', 5);
            passwordJobs++;
            try { await handler(req, res); } finally { passwordJobs--; }
        });
    }

    router.post('/register', passwordWork(async (req, res) => {
        const { password, acceptTerms } = req.body || {};
        const email = normalizeEmail(req.body?.email);
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
        if (!/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) || email.length > 254) throw new AtlasError(400, 'Enter a valid email address.');
        validatePassword(password);
        if (acceptTerms !== true) throw new AtlasError(400, 'Accept the Terms and Conditions to create an account.');
        if (!(await store.getSettings()).registrationEnabled) throw new AtlasError(403, 'New registrations are currently paused.');
        if (email === normalizeEmail(env.ATLAS_OWNER_EMAIL) || await store.userByEmail(email)) {
            throw new AtlasError(409, 'This address cannot be registered. Try signing in.');
        }
        const now = new Date().toISOString();
        res.status(202).json(await verification.begin(req, res, { email, name, passwordHash: await hashPassword(password),
            purpose: 'register', termsAcceptedAt: now, termsVersion: TERMS_VERSION }));
    }));
    router.get('/verification', route(async (req, res) => { res.json(await verification.pending(req)); }));
    router.post('/verification/resend', route(async (req, res) => {
        res.status(202).json(await verification.resend(req, req.body?.verificationId));
    }));
    router.post('/verification/confirm', passwordWork(async (req, res) => {
        const pending = await verification.verify(req, req.body?.verificationId, req.body?.code);
        const now = new Date().toISOString();
        let user;
        if (pending.purpose === 'register') {
            if (!(await store.getSettings()).registrationEnabled) throw new AtlasError(403, 'New registrations are currently paused.');
            if (pending.email === normalizeEmail(env.ATLAS_OWNER_EMAIL) || await store.userByEmail(pending.email)) {
                throw new AtlasError(409, 'This address cannot be registered. Try signing in.');
            }
            user = await store.createUser({ _id: crypto.randomUUID(), email: pending.email, name: pending.name,
                passwordHash: pending.passwordHash, emailVerifiedAt: now, createdAt: now, lastLoginAt: now,
                termsAcceptedAt: pending.termsAcceptedAt, termsVersion: pending.termsVersion });
            await store.audit({ actor: 'account:' + user._id, action: 'account.created', target: user._id, createdAt: now });
        } else if (pending.purpose === 'login') {
            user = await store.verifyUserEmail(pending.userId, pending.email, pending.authVersion, now);
            if (!user) throw new AtlasError(401, 'Account access changed. Sign in again.');
        } else throw new AtlasError(400, 'This verification request is invalid.');
        await store.audit({ actor: 'account:' + user._id, action: 'account.email_verified', target: user._id, createdAt: now });
        await issue(req, res, user);
        verification.clear(res);
        res.status(pending.purpose === 'register' ? 201 : 200).json({ user: publicUser(user, ownerId) });
    }));
    router.post('/login', passwordWork(async (req, res) => {
        const email = normalizeEmail(req.body?.email);
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (email.length > 254 || !password || password.length > 128) throw new AtlasError(401, 'Email or password is incorrect.');
        const user = await store.userByEmail(email);
        const valid = await verifyPassword(password, user?.passwordHash || await dummyHash);
        if (!valid || !user || user.disabled) throw new AtlasError(401, 'Email or password is incorrect.');
        if (!user.emailVerifiedAt) {
            return res.status(202).json(await verification.begin(req, res, { email: user.email, purpose: 'login',
                userId: user._id, authVersion: user.authVersion || 0 }));
        }
        const now = new Date().toISOString();
        await store.updateUser(user._id, { lastLoginAt: now });
        await store.audit({ actor: 'account:' + user._id, action: 'account.login', target: user._id, createdAt: now });
        await issue(req, res, user);
        res.json({ user: publicUser(user, ownerId) });
    }));
    router.post('/logout', route(async (req, res) => {
        const token = cookieToken(req, cookieName);
        if (token) await store.deleteSession(hashToken(token));
        res.clearCookie(cookieName, cookieOptions);
        res.sendStatus(204);
    }));
    router.post('/password', passwordWork(async (req, res) => {
        const user = requireAccount(req);
        const { currentPassword, newPassword } = req.body || {};
        validatePassword(newPassword);
        if (typeof currentPassword !== 'string' || currentPassword.length > 128 || !await verifyPassword(currentPassword, user.passwordHash)) {
            throw new AtlasError(401, 'The current password is incorrect.');
        }
        const updated = await store.bumpUserAuth(user._id, { passwordHash: await hashPassword(newPassword) });
        await store.deleteUserSessions(user._id);
        await issue(req, res, updated);
        await store.audit({ actor: 'account:' + user._id, action: 'account.password_changed', target: user._id, createdAt: new Date().toISOString() });
        res.sendStatus(204);
    }));
    router.use(createSocialAuth({ store, env, issue, current, verifyPassword, passwordWork, termsVersion: TERMS_VERSION, providers }));
    const settingsRouter = createAccountSettings({ store, env, current, issue, verifyPassword, hashPassword, passwordWork,
        publicUser: user => publicUser(user, ownerId), clearSession: res => res.clearCookie(cookieName, cookieOptions) });
    return { router, settingsRouter, current, attach, requireOwner, user: req => req.account ? publicUser(req.account, ownerId) : null };
}
module.exports = { createAccounts, hashPassword, verifyPassword, TERMS_VERSION };
