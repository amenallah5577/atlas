const express = require('express');
const crypto = require('node:crypto');
const { AtlasError } = require('./research');
const { createProviders } = require('./oauth-providers');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function createSocialAuth({ store, env, issue, current, verifyPassword, passwordWork, termsVersion, providers = createProviders(env) }) {
    const router = express.Router();
    const cookieName = env.NODE_ENV === 'production' ? '__Host-atlas_oauth' : 'atlas_oauth';
    const cookieOptions = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/' };
    let exchanges = 0;
    router.get('/providers', (req, res) => res.json({ providers: providers.list() }));
    router.post('/oauth/:provider/start', passwordWork(async (req, res) => {
        const provider = req.params.provider;
        if (!providers.list().some(item => item.id === provider && item.enabled)) throw new AtlasError(503, 'This sign-in provider is not configured yet.');
        const { link, acceptTerms, currentPassword } = req.body || {};
        if (link !== undefined && typeof link !== 'boolean') throw new AtlasError(400, 'Invalid account link request.');
        if (link) {
            if (!req.account) throw new AtlasError(401, 'Sign in before linking an account.');
            if (req.account.passwordHash) {
                if (typeof currentPassword !== 'string' || currentPassword.length > 128 ||
                    !await verifyPassword(currentPassword, req.account.passwordHash)) throw new AtlasError(401, 'Enter your current password to link a sign-in method.');
            } else if (!req.authSession || Date.now() - new Date(req.authSession.createdAt).getTime() > 5 * 60_000) {
                throw new AtlasError(401, 'Sign in again before linking a sign-in method.');
            }
        }
        const state = random(), browser = random(), codeVerifier = crypto.randomBytes(48).toString('base64url');
        const url = await providers.authorizationURL(provider, { state, codeVerifier });
        await store.createOAuthAttempt({ hash: hash(state), browserHash: hash(browser), provider, codeVerifier,
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), acceptTerms: acceptTerms === true,
            ...(link ? { userId: req.account._id, authVersion: req.account.authVersion || 0 } : {}) });
        res.cookie(cookieName, browser, { ...cookieOptions, maxAge: 10 * 60_000 });
        res.json({ url });
    }));

    router.get('/oauth/:provider/callback', async (req, res) => {
        res.set('Referrer-Policy', 'no-referrer');
        const finish = (reason, success = false) => res.redirect(303, '/atlas?auth=' + (success ? reason : 'error&reason=' + reason));
        const provider = req.params.provider;
        const params = new URL(req.originalUrl, 'http://atlas.invalid').searchParams;
        const state = params.get('state');
        const browser = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
        if (params.getAll('state').length !== 1 || !/^[a-f0-9]{64}$/.test(state || '') || !/^[a-f0-9]{64}$/.test(browser || '')) return finish('expired');
        let acquired = false;
        try {
            const attempt = await store.consumeOAuthAttempt(hash(state), hash(browser), provider);
            if (!attempt) return finish('expired');
            res.clearCookie(cookieName, cookieOptions);
            if (params.has('error')) return finish('cancelled');
            if (params.getAll('code').length !== 1 || !params.get('code') || params.get('code').length > 4096) return finish('provider_failed');
            if (!providers.list().some(item => item.id === provider && item.enabled)) return finish('unavailable');
            if (exchanges >= 4) return finish('provider_failed');
            exchanges++;
            acquired = true;
            const identity = await providers.identity(provider, { query: params.toString(), state, codeVerifier: attempt.codeVerifier });
            if (typeof identity.subject !== 'string' || !identity.subject || identity.subject.length > 255) return finish('provider_failed');
            let user = await store.userByIdentity(provider, identity.subject);
            if (attempt.userId) {
                // The provider round trip may outlive a logout in another tab.
                const account = await current(req);
                if (!account || account.disabled || account._id !== attempt.userId || (account.authVersion || 0) !== attempt.authVersion) return finish('link_expired');
                if (user && user._id !== account._id) return finish('link_conflict');
                try { user = await store.linkIdentity(account._id, provider, identity.subject, attempt.authVersion); }
                catch (error) { if (error.code === 11000 || error.status === 409) return finish('link_conflict'); throw error; }
                if (!user || user.disabled || (user.authVersion || 0) !== attempt.authVersion) return finish('link_expired');
                await store.audit({ actor: 'account:' + user._id, action: 'account.provider_linked', target: user._id, details: { provider } });
                return finish('linked', true);
            }
            if (!user) {
                if (!attempt.acceptTerms) return finish('terms_required');
                if (!(await store.getSettings()).registrationEnabled) return finish('registration_closed');
                const email = normalizeEmail(identity.email);
                if (!/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) || email.length > 254) return finish('email_unavailable');
                if (email === normalizeEmail(env.ATLAS_OWNER_EMAIL) || await store.userByEmail(email)) return finish('email_conflict');
                const now = new Date().toISOString();
                try {
                    user = await store.createUser({ _id: crypto.randomUUID(), email, name: identity.name, createdAt: now, lastLoginAt: now,
                        termsAcceptedAt: now, termsVersion, identities: [{ provider, subject: identity.subject }] });
                    await store.audit({ actor: 'account:' + user._id, action: 'account.created', target: user._id, details: { provider } });
                } catch (error) {
                    if (error.code !== 11000 && error.status !== 409) throw error;
                    user = await store.userByIdentity(provider, identity.subject);
                    if (!user) return finish('email_conflict');
                }
            }
            if (user.disabled) return finish('account_unavailable');
            await store.updateUser(user._id, { lastLoginAt: new Date().toISOString() });
            await store.audit({ actor: 'account:' + user._id, action: 'account.login', target: user._id, details: { provider } });
            await issue(req, res, user);
            return finish('success', true);
        } catch {
            // Provider errors can contain codes and tokens. Never expose or log their bodies.
            return finish('provider_failed');
        } finally { if (acquired) exchanges--; }
    });
    return router;
}
module.exports = { createSocialAuth };
