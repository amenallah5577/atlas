const { setTimeout: pause } = require('node:timers/promises');

function configureDeployment(app, { env = process.env, database } = {}) {
    if (!env.ATLAS_PUBLIC_URL && env.RENDER_EXTERNAL_URL) env.ATLAS_PUBLIC_URL = env.RENDER_EXTERNAL_URL;
    const standalone = env.ATLAS_STANDALONE === 'true';
    if (standalone && env.NODE_ENV === 'production') {
        if (env.ATLAS_STORAGE === 'local' || !/^mongodb(?:\+srv)?:\/\//.test(env.MONGODB_URI || '')) {
            throw new Error('Production Atlas requires a hosted MONGODB_URI; local storage is not supported.');
        }
        if (Buffer.byteLength(env.SESSION_SECRET || '') < 32) throw new Error('Production Atlas requires a stable SESSION_SECRET of at least 32 bytes.');
        let origin;
        try { origin = new URL(env.ATLAS_PUBLIC_URL); } catch { /* Checked below. */ }
        if (!origin || origin.protocol !== 'https:' || origin.username || origin.password ||
            origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Set ATLAS_PUBLIC_URL to the public HTTPS origin.');
        if (!env.ATLAS_GROQ_API_KEY || !env.ATLAS_TAVILY_API_KEY || env.ATLAS_LLM_PROVIDER !== 'groq' ||
            env.ATLAS_FREE_PROVIDERS_CONFIRMED !== 'true') throw new Error('Configure the confirmed free Groq and Tavily accounts before deploying Atlas.');
    }
    if (env.ATLAS_TRUST_PROXY !== undefined) {
        if (!/^[0-3]$/.test(env.ATLAS_TRUST_PROXY)) throw new Error('ATLAS_TRUST_PROXY must be an explicit proxy hop count from 0 to 3.');
        app.set('trust proxy', Number(env.ATLAS_TRUST_PROXY));
    }
    app.disable('x-powered-by');
    const state = { draining: false };
    app.use((req, res, next) => {
        if (standalone || req.path.startsWith('/atlas') || req.path.startsWith('/api/atlas')) {
            res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
            if (env.NODE_ENV === 'production' && req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
        }
        next();
    });
    app.get('/healthz', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const local = env.ATLAS_STORAGE === 'local' && env.NODE_ENV !== 'production';
        if (state.draining || (!local && database.connection.readyState !== 1)) return res.status(503).json({ status: 'unavailable' });
        let timer;
        try {
            if (!local) await Promise.race([
                database.connection.db.command({ ping: 1 }),
                new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Database health timeout')), 2500); })
            ]);
            res.json({ status: 'ok', storage: local ? 'local' : 'mongodb' });
        } catch { res.status(503).json({ status: 'unavailable' }); }
        finally { clearTimeout(timer); }
    });
    return state;
}

async function startServer(app, { env = process.env, database, state, beforeClose = async () => {} } = {}) {
    if (env.MONGODB_URI) {
        try {
            await database.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000, maxPoolSize: 10 });
            await Promise.all(Object.values(database.models).map(model => model.init()));
        } catch {
            await database.disconnect().catch(() => {});
            throw new Error('MongoDB startup failed. Check the private connection settings and database network access.');
        }
    }
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(Number(env.PORT || 3000), '0.0.0.0', () => resolve(listener));
        listener.once('error', reject);
    });
    let closing;
    server.shutdown = () => closing ||= (async () => {
        state.draining = true;
        const stopped = new Promise(resolve => server.close(resolve));
        await Promise.race([beforeClose(), pause(8000, undefined, { ref: false })]);
        server.closeAllConnections?.();
        await stopped;
        await database.disconnect();
    })();
    return server;
}

module.exports = { configureDeployment, startServer };
