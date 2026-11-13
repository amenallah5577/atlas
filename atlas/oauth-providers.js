const { AtlasError } = require('./research');

const definitions = {
    google: { name: 'Google', issuer: 'https://accounts.google.com',
        authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
        jwks: 'https://www.googleapis.com/oauth2/v3/certs', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
        scope: 'openid email profile' },
    github: { name: 'GitHub', issuer: 'https://github.com',
        authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token',
        scope: 'read:user user:email' },
    microsoft: { name: 'Microsoft', issuer: 'https://login.microsoftonline.com/common/v2.0',
        authorization: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'https://graph.microsoft.com/User.Read' }
};

function publicOrigin(env) {
    try {
        const url = new URL(env.ATLAS_PUBLIC_URL || (env.NODE_ENV !== 'production' ? 'http://127.0.0.1:' + (env.PORT || 3000) : ''));
        if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
        if (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) return null;
        return url.origin;
    } catch { return null; }
}

function createProviders(env, request = fetch) {
    const origin = publicOrigin(env);
    const library = import('openid-client');
    const configurations = new Map();
    const configured = id => Boolean(origin && env['ATLAS_' + id.toUpperCase() + '_CLIENT_ID']?.trim() &&
        env['ATLAS_' + id.toUpperCase() + '_CLIENT_SECRET']?.trim());
    function callback(id) { return origin + '/api/atlas/auth/oauth/' + id + '/callback'; }
    async function config(id) {
        if (!Object.hasOwn(definitions, id) || !configured(id)) throw new AtlasError(503, 'This sign-in provider is not configured yet.');
        if (!configurations.has(id)) {
            const client = await library;
            const provider = definitions[id];
            const result = new client.Configuration({ issuer: provider.issuer, authorization_endpoint: provider.authorization,
                token_endpoint: provider.token, ...(provider.jwks ? { jwks_uri: provider.jwks, userinfo_endpoint: provider.userinfo } : {}) },
            env['ATLAS_' + id.toUpperCase() + '_CLIENT_ID'].trim(), {},
            client.ClientSecretPost(env['ATLAS_' + id.toUpperCase() + '_CLIENT_SECRET'].trim()));
            result.timeout = 15;
            result[client.customFetch] = request;
            if (id === 'google') client.enableNonRepudiationChecks(result);
            configurations.set(id, result);
        }
        return configurations.get(id);
    }
    async function json(url, token) {
        const response = await request(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json',
            'User-Agent': 'EchoSphere-Atlas', ...(url.startsWith('https://api.github.com/') ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error('Provider profile unavailable');
        // User profiles are small; bound the stream rather than trusting Content-Length.
        const reader = response.body.getReader();
        const parts = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 65_536) throw new Error('Provider profile too large');
                parts.push(Buffer.from(value));
            }
        } finally { await reader.cancel().catch(() => {}); }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
    return {
        origin,
        list: () => Object.entries(definitions).map(([id, provider]) => ({ id, name: provider.name, enabled: configured(id) })),
        async authorizationURL(id, { state, codeVerifier }) {
            const client = await library;
            return client.buildAuthorizationUrl(await config(id), { redirect_uri: callback(id), scope: definitions[id].scope,
                state, code_challenge: await client.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256',
                ...(id === 'google' ? { nonce: await client.calculatePKCECodeChallenge(codeVerifier), prompt: 'select_account' } : {}) }).href;
        },
        async identity(id, { query, state, codeVerifier }) {
            const client = await library;
            const configuration = await config(id);
            const url = new URL(callback(id));
            url.search = query;
            const tokens = await client.authorizationCodeGrant(configuration, url, { expectedState: state, pkceCodeVerifier: codeVerifier,
                ...(id === 'google' ? { expectedNonce: await client.calculatePKCECodeChallenge(codeVerifier), idTokenExpected: true } : {}) });
            let subject, email, name;
            if (id === 'google') {
                const profile = await client.fetchUserInfo(configuration, tokens.access_token, tokens.claims().sub);
                subject = profile.sub;
                email = profile.email_verified === true ? profile.email : null;
                name = profile.name;
            } else if (id === 'github') {
                const profile = await json('https://api.github.com/user', tokens.access_token);
                const emails = await json('https://api.github.com/user/emails', tokens.access_token);
                subject = typeof profile.id === 'number' && Number.isSafeInteger(profile.id) ? String(profile.id) : null;
                email = Array.isArray(emails) ? emails.find(item => item.primary === true && item.verified === true)?.email : null;
                name = profile.name || profile.login;
            } else if (id === 'microsoft') {
                const profile = await json('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', tokens.access_token);
                subject = profile.id;
                email = profile.mail || profile.userPrincipalName;
                name = profile.displayName;
            }
            if (typeof subject !== 'string' || !subject || subject.length > 255) throw new Error('Provider subject unavailable');
            return { subject, email: typeof email === 'string' ? email.trim().toLowerCase() : '',
                name: typeof name === 'string' ? name.trim().slice(0, 80) : '', emailVerified: Boolean(email && id !== 'microsoft') };
        }
    };
}
module.exports = { createProviders, publicOrigin };
