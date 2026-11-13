const { AtlasError } = require('./research');

const invalid = () => new AtlasError(400, 'The code is invalid or expired. Request a new code.');
const cooldown = seconds => new AtlasError(429, 'Wait before requesting another verification email.', Math.max(1, seconds));

function mongoVerificationStore(mongoose) {
    const schema = new mongoose.Schema({
        _id: String, id: String, browserHash: String, email: String, name: String, passwordHash: String,
        purpose: String, userId: String, authVersion: Number, codeHash: String, attempts: Number,
        createdAt: Date, expiresAt: Date, resendAt: Date, termsAcceptedAt: Date, termsVersion: String
    }, { bufferCommands: false });
    schema.index({ id: 1 }, { unique: true });
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Pending = mongoose.models.AtlasEmailVerification || mongoose.model('AtlasEmailVerification', schema);
    const match = (id, browserHash, now) => ({ id, browserHash, expiresAt: { $gt: now } });
    return {
        async putEmailVerification(record, now, previousId) {
            const { _id, ...fields } = record;
            try {
                const result = await Pending.findOneAndUpdate({ _id, resendAt: { $lte: now },
                    ...(previousId ? { id: previousId, browserHash: record.browserHash } : {}) },
                { $set: fields, $setOnInsert: { _id } }, { upsert: !previousId, new: true }).lean();
                if (!result) throw invalid();
                return result;
            } catch (error) {
                if (error.code === 11000) throw cooldown(60);
                throw error;
            }
        },
        getEmailVerification(id, browserHash, now) { return Pending.findOne(match(id, browserHash, now)).lean(); },
        pendingEmailVerification(browserHash, now) { return Pending.findOne({ browserHash, expiresAt: { $gt: now } }).lean(); },
        attemptEmailVerification(id, browserHash, now) {
            return Pending.findOneAndUpdate({ ...match(id, browserHash, now), attempts: { $lt: 5 } },
                { $inc: { attempts: 1 } }, { new: true }).lean();
        },
        consumeEmailVerification(id, browserHash, codeHash, now) {
            return Pending.findOneAndDelete({ ...match(id, browserHash, now), codeHash, attempts: { $lte: 5 } }).lean();
        },
        async deleteEmailVerification(id, browserHash) { await Pending.deleteOne({ id, browserHash }); }
    };
}

function localVerificationStore(read, change) {
    const entries = () => read().emailVerifications ||= {};
    const pending = (id, browserHash, now) => Object.values(entries()).find(record =>
        record.id === id && record.browserHash === browserHash && new Date(record.expiresAt) > now);
    return {
        async putEmailVerification(record, now, previousId) {
            const existing = entries()[record._id];
            if (existing && new Date(existing.resendAt) > now) throw cooldown(Math.ceil((new Date(existing.resendAt) - now) / 1000));
            if (previousId && (!existing || existing.id !== previousId || existing.browserHash !== record.browserHash)) throw invalid();
            return change(() => {
                for (const [key, value] of Object.entries(entries())) if (new Date(value.expiresAt) <= now) delete entries()[key];
                entries()[record._id] = structuredClone(record);
                return structuredClone(record);
            });
        },
        async getEmailVerification(id, browserHash, now) { return structuredClone(pending(id, browserHash, now) || null); },
        async pendingEmailVerification(browserHash, now) {
            return structuredClone(Object.values(entries()).find(record => record.browserHash === browserHash && new Date(record.expiresAt) > now) || null);
        },
        async attemptEmailVerification(id, browserHash, now) {
            const record = pending(id, browserHash, now);
            if (!record || record.attempts >= 5) return null;
            return change(() => { record.attempts++; return structuredClone(record); });
        },
        async consumeEmailVerification(id, browserHash, codeHash, now) {
            const record = pending(id, browserHash, now);
            if (!record || record.codeHash !== codeHash || record.attempts > 5) return null;
            return change(() => { delete entries()[record._id]; return structuredClone(record); });
        },
        async deleteEmailVerification(id, browserHash) {
            const record = Object.values(entries()).find(value => value.id === id && value.browserHash === browserHash);
            if (record) change(() => { delete entries()[record._id]; });
        }
    };
}

module.exports = { mongoVerificationStore, localVerificationStore };
