const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { AtlasError } = require('./research');
const { identity, identities, oauthAttempt, validateAttemptLookup } = require('./oauth-identity');

const conversationSchema = new mongoose.Schema({
    _id: String, owner: { type: String, required: true }, title: String,
    messages: [mongoose.Schema.Types.Mixed], active: String, activeAt: Date, archived: { type: Boolean, default: false },
    createdAt: Date, updatedAt: Date
}, { bufferCommands: false });
conversationSchema.index({ owner: 1, updatedAt: -1 });
conversationSchema.index({ updatedAt: -1, _id: 1 });
const quotaSchema = new mongoose.Schema({
    _id: String, used: Number, expires: Date
}, { bufferCommands: false });
quotaSchema.index({ expires: 1 }, { expireAfterSeconds: 0 });
const Conversation = mongoose.models.AtlasConversation || mongoose.model('AtlasConversation', conversationSchema);
const Quota = mongoose.models.AtlasQuota || mongoose.model('AtlasQuota', quotaSchema);
const userSchema = new mongoose.Schema({
    _id: String,
    email: { type: String, required: true, unique: true },
    name: String,
    passwordHash: String,
    avatarUrl: String,
    preferences: mongoose.Schema.Types.Mixed,
    parental: mongoose.Schema.Types.Mixed,
    parentalVersion: { type: Number, default: 0 },
    identities: { type: [new mongoose.Schema({ provider: String, subject: String, key: String }, { _id: false })], default: undefined },
    disabled: { type: Boolean, default: false },
    authVersion: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: Date,
    termsAcceptedAt: Date,
    termsVersion: String
}, { bufferCommands: false });
userSchema.index({ createdAt: -1, _id: 1 });
userSchema.index({ 'identities.key': 1 }, { unique: true, partialFilterExpression: { 'identities.key': { $type: 'string' } } });
const oauthAttemptSchema = new mongoose.Schema({
    _id: String, hash: String, browserHash: String, provider: String, codeVerifier: String,
    expiresAt: Date, userId: String, authVersion: Number, acceptTerms: Boolean
}, { bufferCommands: false });
oauthAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const sessionSchema = new mongoose.Schema({
    _id: String, hash: { type: String, required: true }, userId: { type: String, required: true, index: true },
    authVersion: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true }, createdAt: { type: Date, default: Date.now }
}, { bufferCommands: false });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const settingsSchema = new mongoose.Schema({
    _id: String, registrationEnabled: Boolean, researchEnabled: Boolean
}, { bufferCommands: false });
const auditSchema = new mongoose.Schema({
    _id: String, actor: String, action: String, target: String, note: String, details: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now }
}, { bufferCommands: false });
auditSchema.index({ createdAt: -1, _id: 1 });
const User = mongoose.models.AtlasUser || mongoose.model('AtlasUser', userSchema);
const OAuthAttempt = mongoose.models.AtlasOAuthAttempt || mongoose.model('AtlasOAuthAttempt', oauthAttemptSchema);
const Session = mongoose.models.AtlasSession || mongoose.model('AtlasSession', sessionSchema);
const Settings = mongoose.models.AtlasSettings || mongoose.model('AtlasSettings', settingsSchema);
const Audit = mongoose.models.AtlasAudit || mongoose.model('AtlasAudit', auditSchema);
const defaults = { registrationEnabled: true, researchEnabled: true };
const publicUserFields = '_id email name disabled createdAt lastLoginAt termsAcceptedAt termsVersion';

function pagination(limit, before, field) {
    const count = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
    if (!before) return { count, filter: {} };
    try {
        const cursor = JSON.parse(Buffer.from(before, 'base64url').toString());
        const at = new Date(cursor.at);
        if (!Number.isFinite(at.getTime()) || typeof cursor.id !== 'string' || cursor.id.length > 80) throw new Error();
        return { count, filter: { $or: [
            { [field]: { $lt: at } }, { [field]: at, _id: { $gt: cursor.id } }
        ] } };
    } catch {
        throw new AtlasError(400, 'Invalid pagination cursor.');
    }
}
function pageResult(items, count, field, key) {
    const visible = items.slice(0, count);
    const last = visible.at(-1);
    const next = items.length > count && last
        ? Buffer.from(JSON.stringify({ at: new Date(last[field]).toISOString(), id: last._id })).toString('base64url') : null;
    return { [key]: visible, next };
}
function searchPattern(query) {
    return String(query || '').trim().slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function userPatch(patch) {
    const allowed = ['email', 'name', 'passwordHash', 'disabled', 'lastLoginAt', 'termsAcceptedAt', 'termsVersion'];
    const update = Object.fromEntries(allowed.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
    if (update.email !== undefined) update.email = String(update.email).trim().toLowerCase();
    return update;
}
function settingsPatch(patch) {
    const update = {};
    for (const key of Object.keys(defaults)) {
        if (!Object.hasOwn(patch, key)) continue;
        if (typeof patch[key] !== 'boolean') throw new AtlasError(400, 'Settings must be true or false.');
        update[key] = patch[key];
    }
    return update;
}

function createStore(env = process.env) {
    if (env.ATLAS_STORAGE === 'local') {
        if (env.NODE_ENV === 'production') throw new Error('Use MongoDB for hosted Atlas storage.');
        return require('./local-store').createLocalStore(env.ATLAS_DATA_FILE || '.atlas-data/store.json');
    }
    return {
        ready() {
            if (mongoose.connection.readyState !== 1) throw new AtlasError(503, 'Atlas history is unavailable. Check the database connection.');
        },
        list(owner, archived = false) {
            return Conversation.find({ owner, archived: archived ? true : { $ne: true } }).select('title updatedAt archived').sort({ updatedAt: -1 }).limit(60).lean();
        },
        get(owner, id) {
            return Conversation.findOne({ _id: id, owner }).lean();
        },
        async create(owner, id) {
            const now = new Date();
            return (await Conversation.create({ _id: id, owner, title: 'New chat', messages: [],
                active: null, createdAt: now, updatedAt: now })).toObject();
        },
        async lock(owner, id, run) {
            const result = await Conversation.updateOne({
                _id: id, owner, $or: [{ active: null }, { activeAt: { $lt: new Date(Date.now() - 180_000) } }]
            }, { $set: { active: run, activeAt: new Date() } });
            return result.modifiedCount === 1;
        },
        async finish(owner, id, run, title, messages) {
            const update = { $set: { active: null, activeAt: null } };
            if (messages.length) {
                update.$set.title = title;
                update.$set.updatedAt = new Date();
                update.$push = { messages: { $each: messages } };
            }
            return (await Conversation.updateOne({ _id: id, owner, active: run }, update)).modifiedCount === 1;
        },
        async remove(owner, id) {
            return (await Conversation.deleteOne({ _id: id, owner,
                $or: [{ active: null }, { activeAt: { $lt: new Date(Date.now() - 180_000) } }] })).deletedCount === 1;
        },
        archive(owner, id, archived) {
            return Conversation.findOneAndUpdate({ _id: id, owner,
                $or: [{ active: null }, { activeAt: { $lt: new Date(Date.now() - 180_000) } }] },
            { $set: { archived } }, { new: true }).lean();
        },
        listAllConversations(owner) {
            return Conversation.find({ owner }).select('-active -activeAt -__v').sort({ updatedAt: -1 }).lean();
        },
        async deleteAllConversations(owner) {
            if (await Conversation.exists({ owner, active: { $ne: null }, activeAt: { $gte: new Date(Date.now() - 180_000) } })) {
                throw new AtlasError(409, 'Stop active replies before deleting chats.');
            }
            return (await Conversation.deleteMany({ owner,
                $or: [{ active: null }, { activeAt: { $lt: new Date(Date.now() - 180_000) } }] })).deletedCount;
        },
        async accountStorage(owner) {
            const [totals] = await Conversation.aggregate([{ $match: { owner } }, { $group: { _id: null,
                conversationCount: { $sum: 1 }, archivedCount: { $sum: { $cond: [{ $eq: ['$archived', true] }, 1, 0] } },
                messageCount: { $sum: { $size: { $ifNull: ['$messages', []] } } }, bytes: { $sum: { $bsonSize: '$$ROOT' } } } }]);
            return { conversationCount: totals?.conversationCount || 0, archivedCount: totals?.archivedCount || 0,
                messageCount: totals?.messageCount || 0, bytes: totals?.bytes || 0 };
        },
        async createUser(user) {
            try {
                const linked = identities(user.identities);
                if (!user.passwordHash && !linked.length) throw new AtlasError(400, 'An account needs a sign-in method.');
                const record = {
                    _id: user._id, email: String(user.email).trim().toLowerCase(), name: user.name,
                    passwordHash: user.passwordHash, disabled: false, createdAt: user.createdAt || new Date(),
                    authVersion: Number.isSafeInteger(user.authVersion) && user.authVersion >= 0 ? user.authVersion : 0,
                    lastLoginAt: user.lastLoginAt, termsAcceptedAt: user.termsAcceptedAt, termsVersion: user.termsVersion
                };
                if (linked.length) record.identities = linked;
                return (await User.create(record)).toObject();
            } catch (error) {
                if (error.code === 11000) throw new AtlasError(409, 'An account with that email already exists.');
                throw error;
            }
        },
        userByEmail(email) {
            return User.findOne({ email: String(email).trim().toLowerCase() }).lean();
        },
        userById(id) {
            return User.findById(id).lean();
        },
        userByIdentity(provider, subject) {
            return User.findOne({ 'identities.key': identity(provider, subject).key }).lean();
        },
        async linkIdentity(userId, provider, subject, expectedAuthVersion) {
            const linked = identity(provider, subject);
            if (expectedAuthVersion !== undefined && (!Number.isSafeInteger(expectedAuthVersion) || expectedAuthVersion < 0)) {
                throw new AtlasError(400, 'Invalid account authentication version.');
            }
            const guard = { _id: userId, disabled: { $ne: true } };
            if (expectedAuthVersion === 0) guard.$or = [{ authVersion: 0 }, { authVersion: { $exists: false } }];
            else if (expectedAuthVersion !== undefined) guard.authVersion = expectedAuthVersion;
            try {
                const updated = await User.findOneAndUpdate({ ...guard, 'identities.provider': { $ne: provider } },
                    { $push: { identities: linked } }, { new: true, runValidators: true }).lean();
                if (updated) return updated;
                const user = await User.findOne(guard).lean();
                if (!user || user.identities?.some(item => item.key === linked.key)) return user;
                throw new AtlasError(409, 'That sign-in provider is already linked.');
            } catch (error) {
                if (error.code === 11000) throw new AtlasError(409, 'That sign-in identity is already linked to an account.');
                throw error;
            }
        },
        async createOAuthAttempt(attempt) {
            const record = oauthAttempt(attempt);
            try { return (await OAuthAttempt.create({ ...record, _id: record.hash })).toObject(); }
            catch (error) {
                if (error.code === 11000) throw new AtlasError(409, 'Sign-in attempt already exists.');
                throw error;
            }
        },
        consumeOAuthAttempt(hash, browserHash, provider) {
            validateAttemptLookup(hash, browserHash, provider);
            return OAuthAttempt.findOneAndDelete({ _id: hash, browserHash, provider, expiresAt: { $gt: new Date() } }).lean();
        },
        async updateUser(id, patch) {
            try {
                return await User.findByIdAndUpdate(id, { $set: userPatch(patch) }, { new: true, runValidators: true }).lean();
            } catch (error) {
                if (error.code === 11000) throw new AtlasError(409, 'An account with that email already exists.');
                throw error;
            }
        },
        async updateAccount(id, patch, expectedAuthVersion, expectedParentalVersion) {
            const allowed = ['name', 'avatarUrl', 'preferences', 'parental'];
            const update = Object.fromEntries(allowed.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
            const filter = { _id: id, disabled: { $ne: true } };
            const conditions = [];
            if (expectedAuthVersion === 0) conditions.push({ $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }] });
            else if (expectedAuthVersion !== undefined) filter.authVersion = expectedAuthVersion;
            if (expectedParentalVersion === 0) conditions.push({ $or: [{ parentalVersion: 0 }, { parentalVersion: { $exists: false } }] });
            else if (expectedParentalVersion !== undefined) filter.parentalVersion = expectedParentalVersion;
            if (conditions.length) filter.$and = conditions;
            const values = { ...update };
            if (Object.hasOwn(values, 'preferences')) {
                delete values.preferences;
                for (const [key, value] of Object.entries(update.preferences)) values['preferences.' + key] = value;
            }
            const changes = { $set: values };
            if (Object.hasOwn(update, 'parental')) changes.$inc = { parentalVersion: 1 };
            return User.findOneAndUpdate(filter, changes, { new: true, runValidators: true }).lean();
        },
        async listUsers({ query = '', limit = 50, before = '' } = {}) {
            const { count, filter } = pagination(limit, before, 'createdAt');
            const pattern = searchPattern(query);
            const search = pattern ? { $or: [{ email: { $regex: pattern, $options: 'i' } }, { name: { $regex: pattern, $options: 'i' } }] } : {};
            const users = await User.find({ $and: [filter, search] }).select(publicUserFields)
                .sort({ createdAt: -1, _id: 1 }).limit(count + 1).lean();
            return pageResult(users, count, 'createdAt', 'users');
        },
        bumpUserAuth(id, patch = {}) {
            const update = {};
            if (Object.hasOwn(patch, 'passwordHash')) {
                if (typeof patch.passwordHash !== 'string' || !patch.passwordHash) throw new AtlasError(400, 'Invalid password hash.');
                update.passwordHash = patch.passwordHash;
            }
            if (Object.hasOwn(patch, 'disabled')) {
                if (typeof patch.disabled !== 'boolean') throw new AtlasError(400, 'Invalid account status.');
                update.disabled = patch.disabled;
            }
            return User.findByIdAndUpdate(id, { $inc: { authVersion: 1 }, $set: update }, { new: true, runValidators: true }).lean();
        },
        async createSession(session) {
            try {
                return (await Session.create({ ...session, _id: session.hash,
                    authVersion: Number.isSafeInteger(session.authVersion) && session.authVersion >= 0 ? session.authVersion : 0 })).toObject();
            } catch (error) {
                if (error.code === 11000) throw new AtlasError(409, 'Session already exists.');
                throw error;
            }
        },
        sessionByHash(hash) {
            return Session.findOne({ _id: hash, expiresAt: { $gt: new Date() } }).lean();
        },
        async deleteSession(hash) {
            return (await Session.deleteOne({ _id: hash })).deletedCount === 1;
        },
        async deleteUserSessions(userId) {
            return (await Session.deleteMany({ userId })).deletedCount;
        },
        listUserSessions(userId) {
            return Session.find({ userId, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
        },
        async deleteOtherSessions(userId, exceptHash) {
            return (await Session.deleteMany({ userId, hash: { $ne: exceptHash } })).deletedCount;
        },
        async deleteAccount(userId, expectedAuthVersion) {
            const owner = 'account:' + userId;
            if (await Conversation.exists({ owner, active: { $ne: null }, activeAt: { $gte: new Date(Date.now() - 180_000) } })) {
                throw new AtlasError(409, 'Stop active replies before deleting your account.');
            }
            const filter = { _id: userId, disabled: { $ne: true } };
            if (expectedAuthVersion === 0) filter.$or = [{ authVersion: 0 }, { authVersion: { $exists: false } }];
            else if (expectedAuthVersion !== undefined) filter.authVersion = expectedAuthVersion;
            const user = await User.findOneAndDelete(filter).lean();
            if (!user) return false;
            await Session.deleteMany({ userId });
            await OAuthAttempt.deleteMany({ userId });
            await Conversation.deleteMany({ owner });
            return true;
        },
        async adminConversations({ owner = '', query = '', limit = 50, before = '' } = {}) {
            const { count, filter } = pagination(limit, before, 'updatedAt');
            const pattern = searchPattern(query);
            const search = pattern ? { $or: [
                { title: { $regex: pattern, $options: 'i' } },
                { 'messages.text': { $regex: pattern, $options: 'i' } }
            ] } : {};
            const criteria = { $and: [filter, owner ? { owner } : {}, search] };
            const conversations = await Conversation.aggregate([
                { $match: criteria }, { $sort: { updatedAt: -1, _id: 1 } }, { $limit: count + 1 },
                { $project: {
                    owner: 1, title: 1, updatedAt: 1, createdAt: 1,
                    messageCount: { $size: { $ifNull: ['$messages', []] } },
                    lastUser: { $arrayElemAt: [{ $filter: { input: { $ifNull: ['$messages', []] }, as: 'message',
                        cond: { $eq: ['$$message.role', 'user'] } } }, -1] }
                } },
                { $project: { owner: 1, title: 1, updatedAt: 1, createdAt: 1, messageCount: 1,
                    lastPrompt: { $ifNull: ['$lastUser.text', ''] }, kind: { $ifNull: ['$lastUser.mode', ''] } } }
            ]);
            return pageResult(conversations, count, 'updatedAt', 'conversations');
        },
        adminConversation(id) {
            return Conversation.findById(id).lean();
        },
        async adminOverview() {
            const [userCount, conversationCount] = await Promise.all([User.countDocuments({}), Conversation.countDocuments({})]);
            return { userCount, conversationCount };
        },
        async getSettings() {
            const settings = await Settings.findById('global').lean();
            return { registrationEnabled: settings?.registrationEnabled ?? true, researchEnabled: settings?.researchEnabled ?? true };
        },
        async saveSettings(patch) {
            const update = settingsPatch(patch);
            const settings = await Settings.findByIdAndUpdate('global', {
                $set: update, $setOnInsert: Object.fromEntries(Object.entries(defaults).filter(([key]) => !Object.hasOwn(update, key)))
            }, { upsert: true, new: true }).lean();
            return { registrationEnabled: settings.registrationEnabled, researchEnabled: settings.researchEnabled };
        },
        async audit(entry) {
            return (await Audit.create({ ...entry, note: typeof entry.note === 'string' ? entry.note.slice(0, 5000) : '',
                _id: randomUUID(), createdAt: new Date() })).toObject();
        },
        listAudit(limit = 50) {
            return Audit.find({}).select('-__v').sort({ createdAt: -1, _id: 1 })
                .limit(Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100))).lean();
        },
        async reserve(provider, window, amount, max) {
            const now = new Date();
            const end = window === 'month' ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) :
                window === 'day' ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) :
                    (Math.floor(now.getTime() / 60_000) + 1) * 60_000;
            const key = provider + ':' + window + ':' + end;
            if (amount <= max) {
                try {
                    await Quota.updateOne({ _id: key, used: { $lte: max - amount } },
                        { $inc: { used: amount }, $setOnInsert: { expires: new Date(end + 86_400_000) } }, { upsert: true });
                    return;
                } catch (error) {
                    if (error.code !== 11000) throw error;
                }
            }
            throw new AtlasError(429, 'Atlas has reached its free usage allowance for this ' + window + '.',
                Math.ceil((end - now.getTime()) / 1000));
        }
    };
}

module.exports = { createStore };
