const crypto = require('node:crypto');
const { AtlasError } = require('./research');
const { createEmailDelivery, validEmail } = require('./email-delivery');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const invalid = () => new AtlasError(400, 'The code is invalid or expired. Request a new code.');

function createEmailVerification({ store, env, delivery = createEmailDelivery(env), clock = () => new Date() }) {
    const cookieName = env.NODE_ENV === 'production' ? '__Host-atlas_verify' : 'atlas_verify';
    const cookieOptions = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 10 * 60_000 };
    const mac = value => crypto.createHmac('sha256', env.SESSION_SECRET).update(value).digest('hex');
    function browser(req) {
        const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
        return /^[a-f0-9]{64}$/.test(token || '') ? hash(token) : '';
    }
    const present = record => ({ id: record.id, email: record.email, expiresAt: record.expiresAt,
        resendAfter: Math.max(0, Math.ceil((new Date(record.resendAt) - clock()) / 1000)), purpose: record.purpose });
    async function send(record, previousId) {
        delivery.ready();
        if (!env.SESSION_SECRET) throw new AtlasError(503, 'Email verification requires a stable server secret.');
        const now = clock();
        if (previousId && new Date(record.resendAt) > now) throw new AtlasError(429, 'Wait before requesting another verification email.', Math.ceil((new Date(record.resendAt) - now) / 1000));
        await delivery.verifyDomain(record.email);
        await store.reserve('email-free', 'day', 1, 260);
        await store.reserve('email-recipient-' + mac(record.email), 'day', 1, 10);
        const code = String(crypto.randomInt(100000, 1000000));
        const id = crypto.randomBytes(32).toString('hex');
        const next = { ...record, _id: mac(record.email), id, codeHash: mac(id + ':' + code), attempts: 0,
            createdAt: now.toISOString(), expiresAt: new Date(+now + 10 * 60_000).toISOString(), resendAt: new Date(+now + 60_000).toISOString() };
        await store.putEmailVerification(next, now, previousId);
        try { await delivery.send({ email: next.email, code, id }); }
        catch (error) { await store.deleteEmailVerification(id, next.browserHash); throw error; }
        return next;
    }
    return {
        configured: () => delivery.configured(),
        async begin(req, res, details) {
            if (!validEmail(details.email)) throw new AtlasError(400, 'Enter a valid, deliverable email address.');
            const token = crypto.randomBytes(32).toString('hex');
            const record = await send({ ...details, browserHash: hash(token) });
            res.cookie(cookieName, token, cookieOptions);
            return { verification: present(record) };
        },
        async pending(req) {
            const binding = browser(req);
            const record = binding ? await store.pendingEmailVerification(binding, clock()) : null;
            return { verification: record ? present(record) : null };
        },
        async resend(req, id) {
            if (!/^[a-f0-9]{64}$/.test(id || '')) throw invalid();
            const record = await store.getEmailVerification(id, browser(req), clock());
            if (!record) throw invalid();
            return { verification: present(await send(record, id)) };
        },
        async verify(req, id, code) {
            if (!/^[a-f0-9]{64}$/.test(id || '') || !/^\d{6}$/.test(code || '')) throw invalid();
            const binding = browser(req), now = clock();
            const record = await store.attemptEmailVerification(id, binding, now);
            if (!record) throw invalid();
            const codeHash = mac(id + ':' + code);
            if (!crypto.timingSafeEqual(Buffer.from(record.codeHash, 'hex'), Buffer.from(codeHash, 'hex'))) throw invalid();
            const consumed = await store.consumeEmailVerification(id, binding, codeHash, now);
            if (!consumed) throw invalid();
            return consumed;
        },
        clear(res) { res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined }); }
    };
}
module.exports = { createEmailVerification };
