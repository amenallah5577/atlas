const express = require('express');
const { AtlasError } = require('./research');

function createAdministration({ store, accounts, env }) {
    const router = express.Router();
    const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
    const record = (req, action, target, note = '') => store.audit({
        actor: 'account:' + req.account._id, action, target, note, createdAt: new Date().toISOString()
    });
    router.use((req, res, next) => {
        try { accounts.requireOwner(req); next(); } catch (error) { next(error); }
    });
    router.get('/overview', route(async (req, res) => {
        const totals = await store.adminOverview();
        res.json({ ...totals, settings: await store.getSettings(), storage: env.ATLAS_STORAGE === 'local' ? 'local' : 'mongodb' });
    }));
    router.get('/users', route(async (req, res) => {
        res.json(await store.listUsers({ query: String(req.query.query || '').slice(0, 200),
            before: String(req.query.before || '').slice(0, 500), limit: 30 }));
    }));
    router.patch('/users/:id', route(async (req, res) => {
        if (typeof req.body?.disabled !== 'boolean') throw new AtlasError(400, 'Choose whether the account should be disabled.');
        if (req.params.id === env.ATLAS_OWNER_ID) throw new AtlasError(400, 'The owner account cannot be disabled.');
        const user = await store.userById(req.params.id);
        if (!user) throw new AtlasError(404, 'Account not found.');
        await store.bumpUserAuth(user._id, { disabled: req.body.disabled });
        if (req.body.disabled) await store.deleteUserSessions(user._id);
        await record(req, req.body.disabled ? 'account.disabled' : 'account.enabled', user._id);
        res.json({ user: { _id: user._id, email: user.email, name: user.name, disabled: req.body.disabled } });
    }));
    router.get('/conversations', route(async (req, res) => {
        const result = await store.adminConversations({ owner: String(req.query.owner || '').slice(0, 160),
            query: String(req.query.query || '').slice(0, 200), before: String(req.query.before || '').slice(0, 500), limit: 30 });
        await record(req, 'admin.history_listed', String(req.query.owner || 'all'));
        res.json(result);
    }));
    router.get('/conversations/:id', route(async (req, res) => {
        const conversation = await store.adminConversation(req.params.id);
        if (!conversation) throw new AtlasError(404, 'Conversation not found.');
        await record(req, 'admin.conversation_read', conversation._id);
        res.json(conversation);
    }));
    router.post('/conversations/:id/review', route(async (req, res) => {
        const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
        if (!note || note.length > 2000) throw new AtlasError(400, 'Enter a review note of up to 2,000 characters.');
        if (!await store.adminConversation(req.params.id)) throw new AtlasError(404, 'Conversation not found.');
        await record(req, 'admin.conversation_reviewed', req.params.id, note);
        res.sendStatus(204);
    }));
    router.get('/audit', route(async (req, res) => {
        res.json({ events: await store.listAudit(100) });
    }));
    router.patch('/settings', route(async (req, res) => {
        const patch = {};
        for (const field of ['registrationEnabled', 'researchEnabled']) {
            if (req.body?.[field] !== undefined) {
                if (typeof req.body[field] !== 'boolean') throw new AtlasError(400, 'Invalid setting.');
                patch[field] = req.body[field];
            }
        }
        if (!Object.keys(patch).length) throw new AtlasError(400, 'Choose a setting to change.');
        const settings = await store.saveSettings(patch);
        await record(req, 'admin.settings_changed', 'site', JSON.stringify(patch));
        res.json({ settings });
    }));
    return router;
}
module.exports = { createAdministration };
