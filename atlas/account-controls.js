const { AtlasError } = require('./research');
const { parental } = require('./account-preferences');

// A conservative filter for explicit requests, separate from any model prompt.
// It is deliberately limited; this is not a guarantee about all generated content.
const explicitContent = /\b(?:porn(?:ography|ographic)?|hentai|erotica|sexually explicit|graphic sex|sexual roleplay|nude (?:photos?|images?|pictures?)|graphic (?:gore|torture|dismemberment)|gore (?:images?|photos?|videos?)|snuff (?:videos?|films?))\b/i;

function enforceControls({ user, input, kind, hasFile = false, reusesEvidence = false }) {
    const controls = parental(user);
    if (!controls?.enabled) return;
    if (!controls.pdfUploads && hasFile) throw new AtlasError(403, 'PDF uploads are disabled in this account’s parental controls.');
    if (!controls.webResearch && ['jobs', 'marketplace', 'research'].includes(kind) && (!reusesEvidence || input.refresh)) {
        throw new AtlasError(403, 'Web research is disabled in this account’s parental controls.');
    }
    const text = [input.text, ...Object.values(input.filters || {})].join(' ');
    if (controls.contentFilter && explicitContent.test(text)) {
        throw new AtlasError(403, 'This request is blocked by this account’s explicit-content filter.');
    }
}
module.exports = { enforceControls, explicitContent };
