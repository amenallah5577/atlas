const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AtlasError } = require('./research');
const { identity, identities, oauthAttempt, validateAttemptLookup } = require('./oauth-identity');
const { localVerificationStore } = require('./email-verification-store');

// Personal, single-process storage. Hosted deployments continue to use MongoDB.
function createLocalStore(filename) {
    const file = path.resolve(filename);
    let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { chats: {}, quotas: {} };
    data.users ||= {};
    for (const user of Object.values(data.users)) user.authVersion ??= 0;
    data.sessions ||= {};
    data.oauthAttempts ||= {};
    data.settings = { registrationEnabled: true, researchEnabled: true, ...data.settings };
    data.audit ||= [];
    function change(operation) {
        const before = structuredClone(data);
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            const result = operation();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
            fs.renameSync(temporary, file);
            return result;
        } catch (error) {
            data = before;
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
            throw error;
        }
    }
    function owned(owner, id) { return data.chats[id]?.owner === owner ? data.chats[id] : null; }
    function busy(chat) { return chat.active && Date.now() - chat.activeAt < 180_000; }
    function publicUser(user) {
        const fields = ['_id', 'email', 'name', 'disabled', 'createdAt', 'lastLoginAt', 'termsAcceptedAt', 'termsVersion'];
        return Object.fromEntries(fields.filter(key => Object.hasOwn(user, key)).map(key => [key, user[key]]));
    }
    function page(items, limit, before, field, key) {
        const count = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
        let cursor;
        if (before) {
            try {
                cursor = JSON.parse(Buffer.from(before, 'base64url').toString());
                const date = new Date(cursor.at);
                if (!Number.isFinite(date.getTime()) || typeof cursor.id !== 'string' || cursor.id.length > 80) throw new Error();
                cursor.at = date.toISOString();
            } catch { throw new AtlasError(400, 'Invalid pagination cursor.'); }
        }
        const sorted = items.sort((a, b) => String(b[field]).localeCompare(String(a[field])) || a._id.localeCompare(b._id))
            .filter(item => !cursor || item[field] < cursor.at || (item[field] === cursor.at && item._id > cursor.id));
        const visible = sorted.slice(0, count);
        const last = visible.at(-1);
        const next = sorted.length > count && last
            ? Buffer.from(JSON.stringify({ at: last[field], id: last._id })).toString('base64url') : null;
        return { [key]: structuredClone(visible), next };
    }
    return {
        ...localVerificationStore(() => data, change),
        ready() {},
        async list(owner, archived = false) {
            return Object.values(data.chats).filter(chat => chat.owner === owner && (chat.archived === true) === archived)
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60)
                .map(chat => ({ _id: chat._id, title: chat.title, updatedAt: chat.updatedAt, archived: chat.archived === true }));
        },
        async get(owner, id) { return structuredClone(owned(owner, id)); },
        async create(owner, id) {
            return change(() => {
                const now = new Date().toISOString();
                data.chats[id] = { _id: id, owner, title: 'New chat', messages: [], createdAt: now, updatedAt: now };
                return structuredClone(data.chats[id]);
            });
        },
        async lock(owner, id, run) {
            const chat = owned(owner, id);
            if (!chat || busy(chat)) return false;
            return change(() => { chat.active = run; chat.activeAt = Date.now(); return true; });
        },
        async finish(owner, id, run, title, messages) {
            const chat = owned(owner, id);
            if (!chat || chat.active !== run) return false;
            return change(() => {
                chat.active = null;
                if (messages.length) {
                    chat.title = title;
                    chat.updatedAt = new Date().toISOString();
                    chat.messages.push(...messages);
                }
                return true;
            });
        },
        async remove(owner, id) {
            const chat = owned(owner, id);
            if (!chat || busy(chat)) return false;
            return change(() => { delete data.chats[id]; return true; });
        },
        async archive(owner, id, archived) {
            const chat = owned(owner, id);
            if (!chat || busy(chat)) return null;
            return change(() => { chat.archived = archived; return structuredClone(chat); });
        },
        async listAllConversations(owner) {
            return structuredClone(Object.values(data.chats).filter(chat => chat.owner === owner)
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ active, activeAt, ...chat }) => chat));
        },
        async deleteAllConversations(owner) {
            const chats = Object.values(data.chats).filter(chat => chat.owner === owner);
            if (chats.some(busy)) throw new AtlasError(409, 'Stop active replies before deleting chats.');
            return change(() => { for (const chat of chats) delete data.chats[chat._id]; return chats.length; });
        },
        async accountStorage(owner) {
            const chats = Object.values(data.chats).filter(chat => chat.owner === owner);
            return { conversationCount: chats.length, archivedCount: chats.filter(chat => chat.archived === true).length,
                messageCount: chats.reduce((count, chat) => count + (chat.messages?.length || 0), 0),
                bytes: Buffer.byteLength(JSON.stringify(chats), 'utf8') };
        },
        async createUser(user) {
            const email = String(user.email).trim().toLowerCase();
            const linked = identities(user.identities);
            if (!user.passwordHash && !linked.length) throw new AtlasError(400, 'An account needs a sign-in method.');
            if (data.users[user._id] || Object.values(data.users).some(record => record.email === email)) {
                throw new AtlasError(409, 'An account with that email already exists.');
            }
            if (Object.values(data.users).some(record => record.identities?.some(existing => linked.some(item => item.key === existing.key)))) {
                throw new AtlasError(409, 'That sign-in identity is already linked to an account.');
            }
            return change(() => {
                const record = {
                    _id: user._id, email, name: user.name, passwordHash: user.passwordHash, disabled: false,
                    authVersion: Number.isSafeInteger(user.authVersion) && user.authVersion >= 0 ? user.authVersion : 0,
                    createdAt: new Date(user.createdAt || Date.now()).toISOString()
                };
                if (linked.length) record.identities = linked;
                for (const key of ['lastLoginAt', 'termsAcceptedAt', 'emailVerifiedAt']) {
                    if (user[key]) record[key] = new Date(user[key]).toISOString();
                }
                if (user.termsVersion) record.termsVersion = user.termsVersion;
                data.users[user._id] = record;
                return structuredClone(record);
            });
        },
        async userByEmail(email) {
            const normalized = String(email).trim().toLowerCase();
            return structuredClone(Object.values(data.users).find(user => user.email === normalized) || null);
        },
        async userById(id) {
            return structuredClone(data.users[id] || null);
        },
        async verifyUserEmail(id, email, authVersion, at) {
            const user = data.users[id];
            if (!user || user.disabled || user.email !== email || (user.authVersion || 0) !== authVersion) return null;
            return change(() => { user.emailVerifiedAt = new Date(at).toISOString(); user.lastLoginAt = new Date(at).toISOString(); return structuredClone(user); });
        },
        async userByIdentity(provider, subject) {
            const linked = identity(provider, subject);
            return structuredClone(Object.values(data.users).find(user => user.identities?.some(item => item.key === linked.key)) || null);
        },
        async linkIdentity(userId, provider, subject, expectedAuthVersion) {
            const linked = identity(provider, subject);
            if (expectedAuthVersion !== undefined && (!Number.isSafeInteger(expectedAuthVersion) || expectedAuthVersion < 0)) {
                throw new AtlasError(400, 'Invalid account authentication version.');
            }
            const user = data.users[userId];
            if (!user || user.disabled || (expectedAuthVersion !== undefined && (user.authVersion || 0) !== expectedAuthVersion)) return null;
            const sameProvider = user.identities?.find(item => item.provider === provider);
            if (sameProvider?.key === linked.key) return structuredClone(user);
            if (sameProvider || Object.values(data.users).some(record => record.identities?.some(item => item.key === linked.key))) {
                throw new AtlasError(409, 'That sign-in provider is already linked.');
            }
            return change(() => {
                user.identities ||= [];
                user.identities.push(linked);
                return structuredClone(user);
            });
        },
        async createOAuthAttempt(attempt) {
            const record = oauthAttempt(attempt);
            return change(() => {
                for (const [hash, existing] of Object.entries(data.oauthAttempts)) {
                    if (new Date(existing.expiresAt).getTime() <= Date.now()) delete data.oauthAttempts[hash];
                }
                if (data.oauthAttempts[record.hash]) throw new AtlasError(409, 'Sign-in attempt already exists.');
                if (Object.keys(data.oauthAttempts).length >= 1000) throw new AtlasError(429, 'Sign-in is busy. Try again shortly.');
                data.oauthAttempts[record.hash] = record;
                return structuredClone(record);
            });
        },
        async consumeOAuthAttempt(hash, browserHash, provider) {
            validateAttemptLookup(hash, browserHash, provider);
            const record = data.oauthAttempts[hash];
            if (!record || record.browserHash !== browserHash || record.provider !== provider || new Date(record.expiresAt).getTime() <= Date.now()) return null;
            return change(() => { delete data.oauthAttempts[hash]; return structuredClone(record); });
        },
        async updateUser(id, patch) {
            const user = data.users[id];
            if (!user) return null;
            const allowed = ['email', 'name', 'passwordHash', 'disabled', 'lastLoginAt', 'termsAcceptedAt', 'termsVersion'];
            const update = Object.fromEntries(allowed.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
            if (Object.hasOwn(update, 'email')) {
                update.email = String(update.email).trim().toLowerCase();
                if (Object.values(data.users).some(record => record._id !== id && record.email === update.email)) {
                    throw new AtlasError(409, 'An account with that email already exists.');
                }
            }
            for (const key of ['lastLoginAt', 'termsAcceptedAt']) {
                if (update[key]) update[key] = new Date(update[key]).toISOString();
            }
            return change(() => { Object.assign(user, update); return structuredClone(user); });
        },
        async updateAccount(id, patch, expectedAuthVersion, expectedParentalVersion) {
            const user = data.users[id];
            if (!user || user.disabled || (expectedAuthVersion !== undefined && (user.authVersion || 0) !== expectedAuthVersion) ||
                (expectedParentalVersion !== undefined && (user.parentalVersion || 0) !== expectedParentalVersion)) return null;
            const allowed = ['name', 'avatarUrl', 'preferences', 'parental'];
            const update = Object.fromEntries(allowed.filter(key => Object.hasOwn(patch, key)).map(key => [key, structuredClone(patch[key])]));
            return change(() => {
                if (update.preferences) update.preferences = { ...user.preferences, ...update.preferences };
                Object.assign(user, update);
                if (Object.hasOwn(update, 'parental')) user.parentalVersion = (user.parentalVersion || 0) + 1;
                return structuredClone(user);
            });
        },
        async listUsers({ query = '', limit = 50, before = '' } = {}) {
            const term = String(query || '').trim().slice(0, 200).toLowerCase();
            const users = Object.values(data.users)
                .filter(user => !term || user.email.includes(term) || String(user.name || '').toLowerCase().includes(term))
                .map(publicUser);
            return page(users, limit, before, 'createdAt', 'users');
        },
        async bumpUserAuth(id, patch = {}) {
            const user = data.users[id];
            if (!user) return null;
            const update = {};
            if (Object.hasOwn(patch, 'passwordHash')) {
                if (typeof patch.passwordHash !== 'string' || !patch.passwordHash) throw new AtlasError(400, 'Invalid password hash.');
                update.passwordHash = patch.passwordHash;
            }
            if (Object.hasOwn(patch, 'disabled')) {
                if (typeof patch.disabled !== 'boolean') throw new AtlasError(400, 'Invalid account status.');
                update.disabled = patch.disabled;
            }
            return change(() => {
                Object.assign(user, update);
                user.authVersion = (user.authVersion || 0) + 1;
                return structuredClone(user);
            });
        },
        async createSession(session) {
            if (data.sessions[session.hash]) throw new AtlasError(409, 'Session already exists.');
            return change(() => {
                for (const [hash, record] of Object.entries(data.sessions)) {
                    if (new Date(record.expiresAt).getTime() <= Date.now()) delete data.sessions[hash];
                }
                const record = {
                    hash: session.hash, userId: session.userId,
                    authVersion: Number.isSafeInteger(session.authVersion) && session.authVersion >= 0 ? session.authVersion : 0,
                    expiresAt: new Date(session.expiresAt).toISOString(),
                    createdAt: new Date(session.createdAt || Date.now()).toISOString()
                };
                data.sessions[session.hash] = record;
                return structuredClone(record);
            });
        },
        async sessionByHash(hash) {
            const session = data.sessions[hash];
            if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
            return structuredClone(session);
        },
        async deleteSession(hash) {
            if (!data.sessions[hash]) return false;
            return change(() => { delete data.sessions[hash]; return true; });
        },
        async deleteUserSessions(userId) {
            return change(() => {
                let count = 0;
                for (const [hash, session] of Object.entries(data.sessions)) {
                    if (session.userId === userId) { delete data.sessions[hash]; count++; }
                }
                return count;
            });
        },
        async listUserSessions(userId) {
            return structuredClone(Object.values(data.sessions).filter(session => session.userId === userId && new Date(session.expiresAt).getTime() > Date.now())
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        },
        async deleteOtherSessions(userId, exceptHash) {
            return change(() => {
                let count = 0;
                for (const [hash, session] of Object.entries(data.sessions)) {
                    if (session.userId === userId && hash !== exceptHash) { delete data.sessions[hash]; count++; }
                }
                return count;
            });
        },
        async deleteAccount(userId, expectedAuthVersion) {
            const user = data.users[userId];
            if (!user || user.disabled || (expectedAuthVersion !== undefined && (user.authVersion || 0) !== expectedAuthVersion)) return false;
            const owner = 'account:' + userId;
            const chats = Object.values(data.chats).filter(chat => chat.owner === owner);
            if (chats.some(busy)) throw new AtlasError(409, 'Stop active replies before deleting your account.');
            return change(() => {
                delete data.users[userId];
                for (const chat of chats) delete data.chats[chat._id];
                for (const [hash, session] of Object.entries(data.sessions)) if (session.userId === userId) delete data.sessions[hash];
                for (const [hash, attempt] of Object.entries(data.oauthAttempts)) if (attempt.userId === userId) delete data.oauthAttempts[hash];
                for (const [key, pending] of Object.entries(data.emailVerifications || {})) if (pending.userId === userId || pending.email === user.email) delete data.emailVerifications[key];
                return true;
            });
        },
        async adminConversations({ owner = '', query = '', limit = 50, before = '' } = {}) {
            const term = String(query || '').trim().slice(0, 200).toLowerCase();
            const conversations = Object.values(data.chats)
                .filter(chat => (!owner || chat.owner === owner) && (!term || String(chat.title || '').toLowerCase().includes(term) ||
                    (Array.isArray(chat.messages) && chat.messages.some(message => String(message.text || '').toLowerCase().includes(term)))))
                .map(chat => {
                    const messages = Array.isArray(chat.messages) ? chat.messages : [];
                    const last = messages.findLast(message => message.role === 'user');
                    return { _id: chat._id, owner: chat.owner, title: chat.title,
                        updatedAt: chat.updatedAt, createdAt: chat.createdAt, messageCount: messages.length,
                        lastPrompt: last?.text || '', kind: last?.mode || '' };
                });
            return page(conversations, limit, before, 'updatedAt', 'conversations');
        },
        async adminConversation(id) {
            return structuredClone(data.chats[id] || null);
        },
        async adminOverview() {
            return { userCount: Object.keys(data.users).length, conversationCount: Object.keys(data.chats).length };
        },
        async getSettings() {
            return structuredClone(data.settings);
        },
        async saveSettings(patch) {
            const update = {};
            for (const key of ['registrationEnabled', 'researchEnabled']) {
                if (!Object.hasOwn(patch, key)) continue;
                if (typeof patch[key] !== 'boolean') throw new AtlasError(400, 'Settings must be true or false.');
                update[key] = patch[key];
            }
            return change(() => {
                Object.assign(data.settings, update);
                return structuredClone(data.settings);
            });
        },
        async audit(entry) {
            return change(() => {
                const record = { actor: entry.actor, action: entry.action, target: entry.target,
                    note: typeof entry.note === 'string' ? entry.note.slice(0, 5000) : '',
                    _id: randomUUID(), createdAt: new Date().toISOString() };
                if (entry.details !== undefined) record.details = structuredClone(entry.details);
                data.audit.unshift(record);
                data.audit = data.audit.slice(0, 1000);
                return structuredClone(record);
            });
        },
        async listAudit(limit = 50) {
            const count = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
            return structuredClone([...data.audit].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a._id.localeCompare(b._id)).slice(0, count));
        },
        async reserve(provider, window, amount, maximum) {
            const now = new Date();
            const end = window === 'month' ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) :
                window === 'day' ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) :
                    (Math.floor(now.getTime() / 60_000) + 1) * 60_000;
            const key = provider + ':' + window + ':' + end;
            if ((data.quotas[key]?.used || 0) + amount > maximum) {
                throw new AtlasError(429, 'Atlas has reached its free usage allowance for this ' + window + '.', Math.ceil((end - now.getTime()) / 1000));
            }
            change(() => {
                for (const [id, quota] of Object.entries(data.quotas)) if (quota.end <= now.getTime()) delete data.quotas[id];
                data.quotas[key] = { used: (data.quotas[key]?.used || 0) + amount, end };
            });
        }
    };
}
module.exports = { createLocalStore };
