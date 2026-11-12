const express = require('express');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { rateLimit } = require('express-rate-limit');
const { AtlasError } = require('./research');
const { preferences, parental, preferencePatch } = require('./account-preferences');

const sessionId = session => crypto.createHash('sha256').update('atlas-visible-session:' + session.hash).digest('hex');

function createAccountSettings({ store, env, current, issue, verifyPassword, hashPassword, passwordWork, publicUser, clearSession }) {
    const router = express.Router();
    const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res))
        .catch(next).finally(() => req.atlasMutationDone?.());
    const mutationLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 50, standardHeaders: 'draft-8', legacyHeaders: false,
        message: { error: 'Too many account changes. Try again in 15 minutes.' } });
    const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
        message: { error: 'Too many security attempts. Try again in 15 minutes.' } });
    router.use(express.json({ limit: '3mb' }));
    router.use((req, res, next) => current(req).then(user => {
        if (!user) throw new AtlasError(401, 'Sign in to manage your account.');
        req.account = user;
        next();
    }).catch(next));
    router.use((req, res, next) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? next() : mutationLimiter(req, res, next));
    const audit = (req, action, details) => store.audit({ actor: 'account:' + req.account._id, action,
        target: req.account._id, ...(details ? { details } : {}) });
    const unchanged = user => {
        if (!user) throw new AtlasError(409, 'Account access or settings changed. Reload and try again.');
        return user;
    };
    async function sensitive(req) {
        const user = await current(req);
        if (!user || user._id !== req.account._id || (user.authVersion || 0) !== (req.account.authVersion || 0)) {
            throw new AtlasError(401, 'Sign in again to continue.');
        }
        if (user.passwordHash) {
            const password = req.body?.currentPassword;
            if (typeof password !== 'string' || password.length > 128 || !await verifyPassword(password, user.passwordHash)) {
                throw new AtlasError(401, 'Confirm your current password to continue.');
            }
        } else if (!req.authSession || Date.now() - new Date(req.authSession.createdAt).getTime() > 5 * 60_000) {
            throw new AtlasError(401, 'Sign in again to continue.');
        }
        return user;
    }
    async function sessions(req) {
        const records = await store.listUserSessions(req.account._id);
        return records.filter(session => (session.authVersion || 0) === (req.account.authVersion || 0)).map(session => ({
            id: sessionId(session), createdAt: session.createdAt, expiresAt: session.expiresAt,
            current: session.hash === req.authSession?.hash
        }));
    }
    router.get('/', route(async (req, res) => {
        const [storage, activeSessions] = await Promise.all([store.accountStorage('account:' + req.account._id), sessions(req)]);
        res.json({ user: publicUser(req.account), preferences: preferences(req.account), parental: parental(req.account), storage, sessions: activeSessions });
    }));
    router.patch('/profile', passwordWork(async (req, res) => {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
            Object.keys(body).some(key => !['name', 'avatarData'].includes(key))) throw new AtlasError(400, 'Choose a profile detail to update.');
        const patch = {};
        if (Object.hasOwn(body, 'name')) {
            if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(body.name)) {
                throw new AtlasError(400, 'Use a display name between 1 and 80 characters.');
            }
            patch.name = body.name.trim();
        }
        if (Object.hasOwn(body, 'avatarData')) {
            if (body.avatarData === null) patch.avatarUrl = '';
            else {
                if (typeof body.avatarData !== 'string' || body.avatarData.length > 2_800_000) throw new AtlasError(400, 'Choose a PNG or JPEG photo under 2 MB.');
                const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.avatarData);
                if (!match || match[2].length % 4 !== 0) throw new AtlasError(400, 'Choose a PNG or JPEG photo under 2 MB.');
                const input = Buffer.from(match[2], 'base64');
                if (input.length > 2 * 1024 * 1024) throw new AtlasError(400, 'Choose a PNG or JPEG photo under 2 MB.');
                try {
                    const image = sharp(input, { limitInputPixels: 5_000_000, failOn: 'warning' }).timeout({ seconds: 5 });
                    const metadata = await image.metadata();
                    if (!['png', 'jpeg'].includes(metadata.format) || metadata.format !== match[1] || (metadata.pages || 1) !== 1) throw new Error();
                    const output = await image.rotate().resize(256, 256, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
                    patch.avatarUrl = 'data:image/jpeg;base64,' + output.toString('base64');
                } catch { throw new AtlasError(400, 'That photo could not be read. Choose a PNG or JPEG up to 5 megapixels.'); }
            }
        }
        const user = unchanged(await store.updateAccount(req.account._id, patch, req.account.authVersion || 0));
        await audit(req, 'account.profile_updated', { fields: Object.keys(patch) });
        res.json({ user: publicUser(user) });
    }));
    router.patch('/preferences', route(async (req, res) => {
        const patch = preferencePatch(req.body);
        const user = unchanged(await store.updateAccount(req.account._id, { preferences: patch }, req.account.authVersion || 0));
        await audit(req, 'account.preferences_updated', { fields: Object.keys(patch) });
        res.json({ preferences: preferences(user) });
    }));
    router.post('/parental', sensitiveLimiter, passwordWork(async (req, res) => {
        const body = req.body;
        const allowed = ['enabled', 'webResearch', 'pdfUploads', 'contentFilter', 'pin', 'currentPin', 'newPin', 'currentPassword'];
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean' ||
            Object.keys(body).some(key => !allowed.includes(key))) throw new AtlasError(400, 'Choose valid parental controls.');
        for (const key of ['webResearch', 'pdfUploads', 'contentFilter']) {
            if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new AtlasError(400, 'Choose valid parental controls.');
        }
        const user = await current(req);
        if (!user || user._id !== req.account._id || (user.authVersion || 0) !== (req.account.authVersion || 0)) throw new AtlasError(401, 'Sign in again to continue.');
        const previous = parental(user);
        let pinHash = user.parental?.pinHash;
        if (previous.enabled) {
            const provided = body.currentPin ?? body.pin;
            if (typeof provided !== 'string' || !/^\d{6}$/.test(provided) || !await verifyPassword(provided, pinHash)) {
                throw new AtlasError(401, 'Enter the current six-digit parental PIN.');
            }
        } else if (body.enabled) await sensitive(req);
        const nextPin = body.newPin ?? (previous.enabled ? (body.currentPin ? body.pin : undefined) : body.pin);
        if (body.enabled && (!previous.enabled || nextPin !== undefined)) {
            if (typeof nextPin !== 'string' || !/^\d{6}$/.test(nextPin)) throw new AtlasError(400, 'Choose a six-digit parental PIN.');
            pinHash = await hashPassword(nextPin);
        }
        const controls = { ...previous, enabled: body.enabled };
        for (const key of ['webResearch', 'pdfUploads', 'contentFilter']) if (body[key] !== undefined) controls[key] = body[key];
        if (body.enabled) controls.pinHash = pinHash;
        const updated = unchanged(await store.updateAccount(user._id, { parental: controls }, user.authVersion || 0, user.parentalVersion || 0));
        await audit(req, 'account.parental_updated');
        res.json({ parental: parental(updated) });
    }));
    router.get('/export', route(async (req, res) => {
        const conversations = await store.listAllConversations('account:' + req.account._id);
        res.set('Content-Disposition', 'attachment; filename="atlas-account-export.json"');
        res.json({ exportedAt: new Date().toISOString(), user: publicUser(req.account), preferences: preferences(req.account),
            parental: parental(req.account), conversations });
    }));
    router.post('/delete-chats', route(async (req, res) => {
        if (req.body?.confirmation !== 'DELETE') throw new AtlasError(400, 'Type DELETE to confirm deleting your chats.');
        const deleted = await store.deleteAllConversations('account:' + req.account._id);
        await audit(req, 'account.chats_deleted', { count: deleted });
        res.json({ deleted });
    }));
    router.delete('/sessions/:id', sensitiveLimiter, route(async (req, res) => {
        if (!/^[a-f0-9]{64}$/.test(req.params.id)) throw new AtlasError(404, 'Session not found.');
        const records = await store.listUserSessions(req.account._id);
        const session = records.find(record => sessionId(record) === req.params.id);
        if (!session) throw new AtlasError(404, 'Session not found.');
        if (session.hash === req.authSession?.hash) throw new AtlasError(400, 'Use Sign out to close this session.');
        await store.deleteSession(session.hash);
        await audit(req, 'account.session_revoked');
        res.sendStatus(204);
    }));
    router.post('/sessions/revoke-others', sensitiveLimiter, passwordWork(async (req, res) => {
        const user = await sensitive(req);
        const session = req.authSession;
        await store.deleteOtherSessions(user._id, session.hash);
        await audit(req, 'account.other_sessions_revoked');
        res.sendStatus(204);
    }));
    router.delete('/', sensitiveLimiter, passwordWork(async (req, res) => {
        if (req.body?.confirmation !== 'DELETE') throw new AtlasError(400, 'Type DELETE to confirm deleting your account.');
        if (req.account._id === env.ATLAS_OWNER_ID) throw new AtlasError(403, 'The owner account cannot be deleted from Atlas.');
        const user = await sensitive(req);
        if (!await store.deleteAccount(user._id, user.authVersion || 0)) throw new AtlasError(409, 'Account access changed. Sign in again.');
        clearSession(res);
        await audit(req, 'account.deleted');
        res.sendStatus(204);
    }));
    return router;
}
module.exports = { createAccountSettings };
