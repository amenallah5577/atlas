const { AtlasError } = require('./research');

const defaults = Object.freeze({
    defaultDepth: 'quick', enterToSend: true, autoScroll: true, theme: 'system', textSize: 'medium',
    backgroundMotion: true, reducedMotion: false, replyNotifications: false, notificationPreview: false,
    breakReminderMinutes: 0, confirmBeforeDelete: true
});
const choices = { defaultDepth: ['quick', 'detailed'], theme: ['system', 'light', 'dark'],
    textSize: ['small', 'medium', 'large'], breakReminderMinutes: [0, 15, 30, 60] };

function preferencePatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AtlasError(400, 'Choose a preference to update.');
    const patch = {};
    for (const [key, value] of Object.entries(body)) {
        if (!Object.hasOwn(defaults, key) || (choices[key] ? !choices[key].includes(value) : typeof value !== 'boolean')) {
            throw new AtlasError(400, 'Invalid account preference.');
        }
        patch[key] = value;
    }
    if (!Object.keys(patch).length) throw new AtlasError(400, 'Choose a preference to update.');
    return patch;
}
function preferences(user) {
    const values = { ...defaults };
    for (const key of Object.keys(defaults)) {
        const value = user?.preferences?.[key];
        if (choices[key] ? choices[key].includes(value) : typeof value === 'boolean') values[key] = value;
    }
    return values;
}
function parental(user) {
    return { enabled: Boolean(user?.parental?.enabled && user?.parental?.pinHash),
        webResearch: user?.parental?.webResearch !== false, pdfUploads: user?.parental?.pdfUploads !== false,
        contentFilter: user?.parental?.contentFilter === true };
}
module.exports = { defaults, preferences, parental, preferencePatch };
