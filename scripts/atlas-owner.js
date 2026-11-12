require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { createStore } = require('../atlas/store');
const { hashPassword, TERMS_VERSION } = require('../atlas/accounts');

function setLocalEnv(name, value) {
    const filename = path.resolve('.env');
    const existing = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
    const lines = existing.split(/\r?\n/).filter(line => line && !line.startsWith(name + '='));
    lines.push(name + '=' + value);
    fs.writeFileSync(filename, lines.join('\n') + '\n', { mode: 0o600 });
    process.env[name] = value;
}
async function importLocal(filename) {
    if (!fs.existsSync(filename)) return;
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const collections = {
        atlasconversations: Object.values(data.chats || {}).map(chat => ({
            ...chat, active: null, activeAt: null, createdAt: new Date(chat.createdAt), updatedAt: new Date(chat.updatedAt)
        })),
        atlasusers: Object.values(data.users || {}).map(user => ({
            ...user, createdAt: new Date(user.createdAt),
            ...(user.lastLoginAt ? { lastLoginAt: new Date(user.lastLoginAt) } : {}),
            ...(user.termsAcceptedAt ? { termsAcceptedAt: new Date(user.termsAcceptedAt) } : {})
        })),
        atlassessions: Object.values(data.sessions || {}).map(session => ({
            ...session, _id: session.hash, createdAt: new Date(session.createdAt), expiresAt: new Date(session.expiresAt)
        })),
        atlasquotas: Object.entries(data.quotas || {}).map(([id, quota]) => ({
            _id: id, used: quota.used, expires: new Date(quota.end + 86400_000)
        })),
        atlasaudits: (data.audit || []).map(entry => ({ ...entry, createdAt: new Date(entry.createdAt) }))
    };
    let imported = 0;
    for (const [name, records] of Object.entries(collections)) {
        if (!records.length) continue;
        const result = await mongoose.connection.collection(name).bulkWrite(records.map(record => ({
            updateOne: { filter: { _id: record._id }, update: { $setOnInsert: record }, upsert: true }
        })));
        imported += result.upsertedCount;
    }
    if (data.settings) await mongoose.connection.collection('atlassettings').updateOne({ _id: 'global' },
        { $setOnInsert: { _id: 'global', ...data.settings } }, { upsert: true });
    console.log('Imported ' + imported + ' local records. Original local data retained.');
}
async function main() {
    const email = (process.env.ATLAS_OWNER_EMAIL || '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw new Error('Set ATLAS_OWNER_EMAIL before provisioning the owner.');
    if (process.env.ATLAS_STORAGE !== 'local') {
        if (!process.env.MONGODB_URI) throw new Error('Configure MONGODB_URI first.');
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
        await Promise.all(Object.values(mongoose.models).map(model => model.init()));
        if (process.argv.includes('--import-local')) await importLocal('.atlas-data/store.json');
    }
    const store = createStore();
    store.ready();
    const existing = await store.userByEmail(email);
    if (existing) {
        if (process.env.ATLAS_OWNER_ID && process.env.ATLAS_OWNER_ID !== existing._id) throw new Error('Owner ID conflicts with the existing account.');
        setLocalEnv('ATLAS_OWNER_ID', existing._id);
        console.log('Owner account already exists. Existing password retained.');
        return;
    }
    const ownerId = process.env.ATLAS_OWNER_ID || crypto.randomUUID();
    const password = crypto.randomBytes(24).toString('base64url');
    const filename = path.resolve('.atlas-data/owner-access.txt');
    if (fs.existsSync(filename)) throw new Error('Owner access file already exists. Preserve it before provisioning a different account.');
    const now = new Date().toISOString();
    await store.createUser({ _id: ownerId, email, name: 'Atlas owner', passwordHash: await hashPassword(password),
        createdAt: now, termsAcceptedAt: now, termsVersion: TERMS_VERSION });
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'Atlas owner access\n\nEmail: ' + email + '\nPassword: ' + password +
        '\n\nOpen /atlas to sign in, then /atlas/admin. Change this generated password in Your account.\n',
        { mode: 0o600, flag: 'wx' });
    setLocalEnv('ATLAS_OWNER_ID', ownerId);
    await store.audit({ actor: 'operator', action: 'owner.provisioned', target: ownerId, createdAt: now });
    console.log('Owner provisioned. Generated credentials saved privately to .atlas-data/owner-access.txt.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
