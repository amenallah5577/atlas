const express = require('express');
const multer = require('multer');
const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const { createStore } = require('./store');
const { createAccounts } = require('./accounts');
const { createAdministration } = require('./administration');
const { enforceControls, explicitContent } = require('./account-controls');
const { profileFor, conversationContext } = require('./model-router');
const { AtlasError, LIMITS, clean, intent, canReuseEvidence, providerClients, research } = require('./research');

const MODE = new Set(['auto', 'chat', 'jobs', 'marketplace', 'research', 'pdf']);
const FILTERS = ['role', 'location', 'work style', 'experience', 'employment type', 'product',
    'delivery country', 'budget', 'currency', 'requirements'];
const ID = /^[0-9a-f-]{36}$/;
const MAX_MESSAGES = 100;

function standaloneProfile(env) {
    const secret = env.SESSION_SECRET || randomBytes(32).toString('hex');
    const signature = id => createHmac('sha256', secret).update(id).digest('hex');
    return (req, res, next) => {
        const cookie = req.headers.cookie?.match(/(?:^|;\s*)atlas_session=([a-f0-9-]{36})\.([a-f0-9]{64})(?:;|$)/);
        let id = cookie?.[1];
        if (!id || !timingSafeEqual(Buffer.from(cookie[2]), Buffer.from(signature(id)))) {
            id = randomUUID();
            res.cookie('atlas_session', id + '.' + signature(id), {
                httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/atlas', maxAge: 30 * 86400_000
            });
        }
        req.profile = { ownerId: 'guest:' + id, mode: 'guest' };
        next();
    };
}

function normalizeInput(body, file) {
    const mode = MODE.has(body.mode) ? body.mode : 'auto';
    const depth = body.depth === 'detailed' ? 'detailed' : 'quick';
    let data = body.filters || {};
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { throw new AtlasError(400, 'Invalid search filters.'); }
    }
    const filters = Object.fromEntries(FILTERS.map(key => [key, clean(data?.[key], 160)]).filter(([, value]) => value));
    const raw = typeof body.text === 'string' ? body.text.trim() : '';
    if (raw.length > 2500) throw new AtlasError(400, 'Keep your message under 2,500 characters.');
    const text = raw || filters.role || filters.product || (file ? 'Summarize this PDF.' : '');
    const refresh = typeof body.refresh === 'string' && ID.test(body.refresh) ? body.refresh : '';
    if (!text && !refresh) throw new AtlasError(400, 'Enter a message or attach a PDF.');
    if (!ID.test(body.clientId || '')) throw new AtlasError(400, 'Invalid message ID.');
    return { text, mode, depth, filters, clientId: body.clientId, refresh };
}

function createAtlasRouter({ profileMiddleware, env = process.env, store = createStore(env), clients = providerClients({ env, store }), authProviders } = {}) {
    const router = express.Router();
    const accounts = createAccounts({ store, env, providers: authProviders });
    const runs = new Map();
    const active = new Map();
    const accountWrites = new Map();
    const accountMaintenance = new Set();
    const upload = multer({ storage: multer.memoryStorage(), limits: {
        fileSize: 5 * 1024 * 1024, files: 1, fields: 8, fieldSize: 12_000, parts: 9
    } });
    const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res))
        .catch(next).finally(() => req.atlasMutationDone?.());
    const owner = req => req.profile.ownerId;
    const keyFor = (ownerId, id) => ownerId + '/' + id;

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            const origin = req.get('origin');
            try {
                if (req.get('sec-fetch-site') === 'cross-site' ||
                    (origin && new URL(origin).host !== req.get('host'))) throw new Error();
            } catch {
                return res.status(403).json({ error: 'Use Atlas from its own website.' });
            }
        }
        next();
    });
    router.use(profileMiddleware || standaloneProfile(env));
    router.use((req, res, next) => accounts.attach(req).then(() => next(), next));
    router.use((req, res, next) => {
        if (req.get('authorization') && req.profile.mode !== 'account') {
            return res.status(401).json({ error: 'Sign in again to continue.' });
        }
        next();
    });
    router.get('/profile', (req, res) => res.json({ mode: req.profile.mode, user: accounts.user(req) }));
    router.get('/capabilities', (req, res) => res.json({ models: clients.describe?.() || { configured: false },
        modes: Object.fromEntries(['quick', 'detailed'].map(depth => [depth, { ...LIMITS[depth], chatMs: profileFor(depth).chatMs }])) }));
    router.use((req, res, next) => {
        try { store.ready(); next(); } catch (error) { next(error); }
    });
    router.use((req, res, next) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        const identity = owner(req);
        const requestPath = req.path.toLowerCase().replace(/\/+$/, '');
        const destructive = (req.method === 'DELETE' && requestPath === '/account') ||
            (req.method === 'POST' && requestPath === '/account/delete-chats');
        if (accountMaintenance.has(identity) || (destructive && ((accountWrites.get(identity) || 0) > 0 ||
            [...active.values()].some(id => runs.get(id)?.owner === identity)))) {
            return next(new AtlasError(409, 'Finish or stop the current account activity before deleting data.'));
        }
        if (destructive) accountMaintenance.add(identity);
        else accountWrites.set(identity, (accountWrites.get(identity) || 0) + 1);
        let released = false;
        const timeout = setTimeout(() => {
            if (req.aborted || res.destroyed) release();
        }, 180_000);
        timeout.unref();
        function release() {
            if (released) return;
            released = true;
            clearTimeout(timeout);
            if (destructive) accountMaintenance.delete(identity);
            else {
                const remaining = (accountWrites.get(identity) || 1) - 1;
                if (remaining) accountWrites.set(identity, remaining); else accountWrites.delete(identity);
            }
        }
        req.atlasMutationDone = release;
        res.once('finish', release);
        if (req.account) accounts.current(req).then(user => {
            if (!user || user._id !== req.account._id) throw new AtlasError(401, 'Sign in again to continue.');
            req.account = user;
            next();
        }).catch(next);
        else next();
    });
    router.use('/auth', accounts.router);
    router.use('/account', accounts.settingsRouter);
    router.use('/admin', createAdministration({ store, accounts, env }));

    async function conversation(req) {
        if (!ID.test(req.params.id)) throw new AtlasError(404, 'Conversation not found.');
        const chat = await store.get(owner(req), req.params.id);
        if (!chat) throw new AtlasError(404, 'Conversation not found.');
        return chat;
    }
    const present = chat => ({ id: chat._id, title: chat.title, messages: chat.messages, updatedAt: chat.updatedAt, archived: chat.archived === true });
    router.get('/conversations', route(async (req, res) => {
        res.json((await store.list(owner(req), req.query.archived === 'true')).map(present));
    }));
    router.post('/conversations', route(async (req, res) => {
        res.status(201).json(present(await store.create(owner(req), randomUUID())));
    }));
    router.get('/conversations/:id', route(async (req, res) => {
        const chat = await conversation(req);
        res.json({ ...present(chat), run: active.get(keyFor(owner(req), chat._id)) || null });
    }));
    router.patch('/conversations/:id', express.json({ limit: '1kb' }), route(async (req, res) => {
        const chat = await conversation(req);
        if (typeof req.body?.archived !== 'boolean' || Object.keys(req.body).some(key => key !== 'archived')) {
            throw new AtlasError(400, 'Choose whether to archive this conversation.');
        }
        if (active.has(keyFor(owner(req), chat._id))) throw new AtlasError(409, 'Stop the active reply before archiving this chat.');
        const updated = await store.archive(owner(req), chat._id, req.body.archived);
        if (!updated) throw new AtlasError(409, 'Stop the active reply before archiving this chat.');
        res.json(present(updated));
    }));
    router.delete('/conversations/:id', route(async (req, res) => {
        const chat = await conversation(req);
        if (active.has(keyFor(owner(req), chat._id))) throw new AtlasError(409, 'Stop the active reply before deleting this chat.');
        if (!await store.remove(owner(req), chat._id)) throw new AtlasError(409, 'Stop the active reply before deleting this chat.');
        res.sendStatus(204);
    }));

    const runLimiter = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: owner,
        standardHeaders: 'draft-8', legacyHeaders: false,
        message: { error: 'Too many messages. Wait a minute and try again.' } });
    router.post('/conversations/:id/messages', runLimiter, upload.single('file'), route(async (req, res) => {
        const chat = await conversation(req);
        const ownerId = owner(req);
        if (chat.archived) throw new AtlasError(409, 'Restore this conversation before sending another message.');
        const activeKey = keyFor(ownerId, chat._id);
        const input = normalizeInput(req.body || {}, req.file);
        const existing = chat.messages.find(message => message.id === input.clientId);
        if (existing) return res.json({ saved: true });
        const activeRun = runs.get(active.get(activeKey));
        if (activeRun?.input.clientId === input.clientId) return res.status(202).json({ run: activeRun.id });
        if (activeRun) throw new AtlasError(409, 'This conversation already has a reply in progress.');
        if (chat.messages.length >= MAX_MESSAGES) throw new AtlasError(409, 'This conversation is full. Start a new chat to continue.');
        if (active.size >= 2 || [...active.values()].some(id => runs.get(id)?.owner === ownerId)) {
            throw new AtlasError(429, 'Atlas is busy. Try again shortly.', 10);
        }
        const previous = chat.messages.findLast(message => message.role === 'assistant' && message.report?.sources?.length)?.report;
        let prior = previous;
        if (input.refresh) {
            const answer = chat.messages.find(message => message.id === input.refresh && message.role === 'assistant');
            const original = chat.messages.find(message => message.id === answer?.replyTo && message.role === 'user');
            if (!original || !['jobs', 'marketplace', 'research'].includes(answer?.report?.kind)) throw new AtlasError(400, 'This answer cannot be refreshed.');
            Object.assign(input, { text: original.text, mode: answer.report.kind, filters: original.filters || {}, depth: original.depth || 'quick' });
            prior = answer.report;
        }
        const kind = intent(input.text, input.mode, !!req.file, prior);
        enforceControls({ user: req.account, input, kind, hasFile: Boolean(req.file), reusesEvidence: canReuseEvidence(input, prior, kind) });
        if (store.getSettings && ['jobs', 'marketplace', 'research'].includes(kind) &&
            !canReuseEvidence(input, prior, kind) && !(await store.getSettings()).researchEnabled) {
            throw new AtlasError(403, 'Live research is currently paused by the site owner.');
        }
        if (kind === 'marketplace' && /\b(?:ship|deliver|shipping|delivery)\b/i.test(input.text) &&
            !input.filters['delivery country'] && /\b(?:ship|deliver)\s+to\s+(?:me|my (?:area|country|address))\b/i.test(input.text)) {
            return res.status(422).json({ error: 'Which country should the seller deliver to?', clarification: { mode: 'marketplace', field: 'delivery country' } });
        }
        if (kind === 'pdf' && !req.file && !prior?.sources?.some(source => !source.url)) throw new AtlasError(400, 'Attach a PDF to continue.');
        if (req.account && store.audit) {
            await store.audit({ actor: ownerId, action: 'research.requested', target: chat._id,
                note: input.text, createdAt: new Date().toISOString() });
        }
        clients.ready(canReuseEvidence(input, prior, kind) ? 'chat' : kind, input.depth);
        const id = randomUUID();
        if (active.size >= 2 || [...active.values()].some(value => runs.get(value)?.owner === ownerId)) {
            throw new AtlasError(429, 'Atlas is busy. Try again shortly.', 10);
        }
        const userMessage = {
            id: input.clientId, role: 'user', text: input.text, filters: input.filters, depth: input.depth,
            mode: kind, attachment: req.file ? clean(req.file.originalname, 120) : '', createdAt: new Date().toISOString()
        };
        const controller = new AbortController();
        const run = { id, owner: ownerId, conversation: chat._id, state: 'running',
            stage: 'Preparing the reply', started: Date.now(), input, userMessage, controller };
        runs.set(id, run);
        active.set(activeKey, id);
        try {
            if (!await store.lock(ownerId, chat._id, id)) throw new AtlasError(409, 'This conversation already has a reply in progress.');
        } catch (error) {
            active.delete(activeKey);
            runs.delete(id);
            throw error;
        }
        res.status(202).json({ run: id });
        let partialReport;
        const timer = setTimeout(() => controller.abort(new AtlasError(504, 'Atlas reached the research time limit.')),
            kind === 'chat' ? profileFor(input.depth).chatMs : LIMITS[input.depth].ms);
        const context = conversationContext(chat.messages, input.depth);
        try {
            const report = await research({ input, kind, prior, context, file: req.file, clients, signal: controller.signal,
                stage: value => { run.stage = value; }, partial: value => { partialReport = value; } });
            controller.signal.throwIfAborted();
            const latestAccount = req.account ? await store.userById(req.account._id) : null;
            if (latestAccount?.parental?.enabled && latestAccount.parental.contentFilter && explicitContent.test(JSON.stringify(report))) {
                partialReport = null;
                throw new AtlasError(403, 'This reply was blocked by this account’s explicit-content filter.');
            }
            run.report = report;
            run.state = 'completed';
        } catch (error) {
            const reason = controller.signal.aborted ? controller.signal.reason : error;
            run.state = reason.status === 499 ? 'cancelled' : partialReport?.sources.length ? 'partial' : 'failed';
            run.error = reason instanceof AtlasError ? reason.message : 'Atlas could not finish this reply. Try again.';
            run.retryAfter = reason.retryAfter || 0;
            if (partialReport?.sources.length) run.report = { ...partialReport, text: run.error };
        } finally {
            clearTimeout(timer);
            try {
                const messages = run.report ? [userMessage, {
                    id, role: 'assistant', replyTo: userMessage.id, text: run.report.text,
                    report: run.report, state: run.state, createdAt: new Date().toISOString()
                }] : [];
                const title = chat.messages.length ? chat.title : clean(input.text, 70);
                if (!await store.finish(ownerId, chat._id, id, title, messages)) throw new Error('Atlas run lock lost');
            } catch {
                run.error = 'The reply could not be saved. It is available in this view until you leave.';
                run.state = run.report ? 'partial' : 'failed';
            }
            run.finished = true;
            active.delete(activeKey);
            setTimeout(() => runs.delete(id), 10 * 60_000).unref();
        }
    }));

    function findRun(req) {
        const run = runs.get(req.params.run);
        if (!run || run.owner !== owner(req)) throw new AtlasError(404, 'Run not found. Reopen the conversation for saved replies.');
        return run;
    }
    router.get('/runs/:run', route((req, res) => {
        const run = findRun(req);
        res.json({ id: run.id, state: run.finished ? run.state : 'running', stage: run.stage, started: run.started,
            userMessage: run.userMessage, report: run.finished ? run.report : undefined,
            error: run.finished ? run.error : undefined, retryAfter: run.finished ? run.retryAfter : undefined });
    }));
    router.delete('/runs/:run', route((req, res) => {
        const run = findRun(req);
        if (!run.finished) run.controller.abort(new AtlasError(499, 'Stopped by you.'));
        res.sendStatus(202);
    }));
    router.use((error, req, res, next) => {
        req.atlasMutationDone?.();
        if (res.headersSent) return next(error);
        if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Upload one PDF under 5 MB.' });
        if (error instanceof AtlasError) {
            if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
            return res.status(error.status).json({ error: error.message, retryAfter: error.retryAfter });
        }
        return res.status(503).json({ error: 'Atlas is temporarily unavailable.' });
    });
    router.ownerPage = route(async (req, res) => {
        store.ready();
        await accounts.attach(req);
        accounts.requireOwner(req);
        res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
        res.sendFile(require('node:path').resolve(__dirname, 'views/admin.html'));
    });
    return router;
}

module.exports = { createAtlasRouter };
