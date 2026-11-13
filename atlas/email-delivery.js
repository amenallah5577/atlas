const { resolveMx, resolve4, resolve6 } = require('node:dns/promises');
const { AtlasError } = require('./research');

function validEmail(email) {
    if (typeof email !== 'string' || email.length > 254) return false;
    const [local, domain, extra] = email.split('@');
    return !extra && local?.length <= 64 && /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/i.test(local || '') &&
        !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain || '');
}

async function verifyDomain(email, dns = { resolveMx, resolve4, resolve6 }) {
    if (!validEmail(email)) throw new AtlasError(400, 'Enter a valid, deliverable email address.');
    const domain = email.split('@')[1];
    if (/(?:^|\.)(?:localhost|invalid|test|example|local)$/i.test(domain)) throw new AtlasError(400, 'This email domain cannot receive mail. Check the address.');
    let timer;
    try {
        const check = async () => {
            try {
                const mx = await dns.resolveMx(domain);
                if (mx.length) return mx.some(record => record.exchange && record.exchange !== '.');
            } catch (error) { if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) throw error; }
            const addresses = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
            return addresses.some(result => result.status === 'fulfilled' && result.value.length);
        };
        const deliverable = await Promise.race([check(), new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('DNS timeout')), 4000);
        })]);
        if (!deliverable) throw new AtlasError(400, 'This email domain cannot receive mail. Check the address.');
    } catch (error) {
        if (error instanceof AtlasError) throw error;
        throw new AtlasError(503, 'Email delivery could not be checked. Try again shortly.');
    } finally { clearTimeout(timer); }
}

function createEmailDelivery(env, request = fetch) {
    let verifiedUntil = 0;
    const configured = () => env.ATLAS_EMAIL_PROVIDER === 'brevo' && Boolean(env.ATLAS_BREVO_API_KEY?.trim()) &&
        validEmail(env.ATLAS_EMAIL_FROM) && env.ATLAS_EMAIL_FREE_PLAN_CONFIRMED === 'true';
    async function api(path, body) {
        let response;
        try {
            response = await request('https://api.brevo.com/v3/' + path, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
                headers: { 'api-key': env.ATLAS_BREVO_API_KEY, Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
        } catch { throw new AtlasError(503, 'The verification email could not be sent. Try again shortly.'); }
        if (!response.ok) throw new AtlasError(response.status === 429 ? 429 : 503,
            response.status === 429 ? 'The free email sending limit has been reached. Try again later.' : 'The verification email service is unavailable.',
            response.status === 429 ? 60 : 0);
        try { return await response.json(); } catch { throw new AtlasError(503, 'The verification email service returned an invalid response.'); }
    }
    return {
        configured, verifyDomain,
        ready() { if (!configured()) throw new AtlasError(503, 'Email verification is being configured. Please try another available sign-in method.'); },
        async send({ email, code, id }) {
            this.ready();
            if (verifiedUntil <= Date.now()) {
                const account = await api('account');
                if (!Array.isArray(account.plan) || !account.plan.some(plan => plan.type === 'free')) {
                    throw new AtlasError(503, 'Atlas requires a confirmed free email sending plan.');
                }
                const senders = await api('senders');
                if (!senders.senders?.some(sender => sender.email?.toLowerCase() === env.ATLAS_EMAIL_FROM.toLowerCase() && sender.active === true)) {
                    throw new AtlasError(503, 'The Atlas verification email sender is not verified yet.');
                }
                verifiedUntil = Date.now() + 5 * 60_000;
            }
            const text = 'Your Atlas verification code is ' + code + '.\n\nEnter this code in the Atlas browser window where you requested it. It expires in 10 minutes.\n\nIf you did not request this email, ignore it. Never share this code with anyone.';
            await api('smtp/email', { sender: { email: env.ATLAS_EMAIL_FROM, name: 'Atlas' }, to: [{ email }],
                subject: 'Verify your Atlas email', textContent: text,
                htmlContent: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#243331"><h1>Verify your email</h1><p>Enter this code in Atlas:</p><p style="font-size:32px;letter-spacing:6px;font-weight:700">' + code + '</p><p>This code expires in 10 minutes.</p><p>If you did not request it, ignore this email. Never share this code with anyone.</p></div>',
                headers: { IdempotencyKey: id }, tags: ['atlas-verification'] });
        }
    };
}
module.exports = { createEmailDelivery, validEmail, verifyDomain };
