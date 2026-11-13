'use strict';

const $ = id => document.getElementById(id);
const controls = {
    jobs: ['role', 'location', 'work style', 'experience', 'employment type'],
    marketplace: ['product', 'delivery country', 'budget', 'currency', 'requirements']
};
const columns = {
    jobs: ['title', 'employer', 'location', 'remote eligibility', 'employment type', 'salary and period', 'posted date', 'requirements'],
    marketplace: ['product and variant', 'seller', 'price and currency', 'availability', 'delivery region', 'shipping and taxes', 'specifications']
};
const kindName = { jobs: 'Jobs', marketplace: 'Marketplace', research: 'Web research', pdf: 'PDF analysis' };
const state = { chat: null, history: [], historyError: '', mode: 'auto', filters: {}, file: null, run: null, submitting: false,
    view: 0, draft: null, identity: null, requests: new AbortController(), clientId: null };
const mobile = matchMedia('(max-width: 800px)');
const preferenceDefaults = { defaultDepth: 'quick', enterToSend: true, autoScroll: true, theme: 'system', textSize: 'medium',
    backgroundMotion: true, reducedMotion: false, replyNotifications: false, notificationPreview: false,
    breakReminderMinutes: 0, confirmBeforeDelete: true };
let uiPreferences = { ...preferenceDefaults };
let uiParental = { enabled: false, webResearch: true, pdfUploads: true, contentFilter: false };
let activeUseMs = 0;
let lastInteraction = Date.now();
let desktopLibraryOpen = true;
try { desktopLibraryOpen = localStorage.getItem('atlas-library-open') !== 'false'; } catch { /* Keep history open when storage is unavailable. */ }
const iconPaths = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
    layers: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',
    echo: '<use href="/atlas-mark.svg?v=echo-4#echosphere"/>',
    compose: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M15 3l6 6M8 16l1-5L19 1l4 4-10 10-5 1Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="m6 6 12 12M6 18 18 6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    login: '<path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5M3 12h12m-4-4 4 4-4 4"/>',
    'user-plus': '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2m3-13v6m-3-3h6"/>',
    moon: '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/>',
    briefcase: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12a20 20 0 0 0 18 0m-9 0v4"/>',
    shopping: '<path d="M5 7h14l2 14H3L5 7Zm3 0V5a4 4 0 0 1 8 0v2"/>',
    paperclip: '<path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7L10 16.4a2 2 0 0 1-2.8-2.8L15 5.8"/>',
    sliders: '<path d="M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4M10 17v4"/>',
    'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    printer: '<path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    chat: '<path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z"/>',
    columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M5.5 7a7.5 7.5 0 0 1 12.7-1L20 12M4 12l1.8 6A7.5 7.5 0 0 0 18.5 17"/>',
    file: '<path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8m-8 4h8"/>',
    archive: '<path d="M4 8v13h16V8M3 3h18v5H3zM9 12h6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>'
};
function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', name === 'echo' ? '0 0 32 32' : '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('glyph');
    svg.innerHTML = iconPaths[name] || iconPaths.chat;
    return svg;
}
function labelWithIcon(node, text, name) {
    node.replaceChildren(icon(name), document.createTextNode(text));
}
for (const node of document.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));
for (const [id, name] of [['evidence-dialog', 'file'], ['comparison-dialog', 'columns'], ['actions-dialog', 'sliders']]) {
    const heading = $(id).querySelector('h2');
    labelWithIcon(heading, heading.textContent, name);
}

function element(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined && text !== null) item.textContent = text;
    if (className) item.className = className;
    return item;
}
function button(text, click, className = 'quiet', iconName) {
    const result = element('button', text, className);
    if (iconName) labelWithIcon(result, text, iconName);
    result.type = 'button';
    result.addEventListener('click', click);
    return result;
}
function externalLink(text, value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol)) return null;
        const anchor = element('a');
        labelWithIcon(anchor, text.replace(/\s*↗$/, ''), 'external');
        anchor.href = url.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        return anchor;
    } catch { return null; }
}
function dateLabel(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}
function feedback(message = '') { $('feedback').textContent = message; }
function explainError(error) {
    if (error.name === 'AbortError') return;
    const delay = error.retryAfter;
    feedback(error.message + (delay ? ' Retry in about ' + Math.max(1, Math.ceil(delay / 60)) + ' minute(s).' : ''));
}
async function api(path, options = {}) {
    const signal = state.requests.signal;
    const headers = new Headers(options.headers);
    const response = await fetch('/api/atlas' + path, { ...options, signal, headers, credentials: 'same-origin' });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Atlas could not complete the request.'), data);
    return data;
}
function scrollBottom() { if (uiPreferences.autoScroll) $('viewport').scrollTop = $('viewport').scrollHeight; }

function renderHistory() {
    const normalize = text => text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
    const query = normalize($('history-search').value).trim();
    const words = query.split(/\s+/).filter(Boolean);
    const matches = state.history.filter(chat => words.every(word => normalize(chat.title).includes(word)));
    $('clear-history-search').hidden = !query;
    $('search-count').textContent = query ? matches.length + ' matching conversation' + (matches.length === 1 ? '' : 's') : '';
    $('history').replaceChildren();
    if (!matches.length) {
        const empty = element('div', null, 'history-empty');
        empty.append(icon(query ? 'search' : 'chat'), element('p', state.historyError || (query ? 'No conversations found.' : 'A fresh start. Your chats will appear here.')));
        $('history').append(empty);
    }
    for (const chat of matches) {
        const control = button('', () => openChat(chat.id), 'history-item');
        const details = element('span', null, 'history-item-details');
        details.append(element('span', chat.title, 'history-item-title'));
        if (chat.updatedAt) details.append(element('span', dateLabel(chat.updatedAt), 'history-item-date'));
        control.append(icon('chat'), details);
        control.title = chat.title;
        if (chat.id === state.chat?.id) control.setAttribute('aria-current', 'true');
        $('history').append(control);
    }
}
async function loadHistory() {
    const signal = state.requests.signal;
    try {
        const list = await api('/conversations');
        if (signal.aborted) return;
        state.history = list;
        state.historyError = '';
    } catch (error) {
        if (signal.aborted) return;
        state.historyError = error.message;
    }
    renderHistory();
}
function library(open) {
    $('library').inert = !open;
    if (mobile.matches) {
        document.body.classList.toggle('mobile-library-open', open);
        $('backdrop').hidden = !open;
        document.querySelector('main').inert = open;
        if (open) $('close-library').focus();
        else $('open-library').focus();
    } else {
        desktopLibraryOpen = open;
        document.body.classList.toggle('library-closed', !open);
        try { localStorage.setItem('atlas-library-open', String(open)); } catch { /* The current view still remembers the choice. */ }
        if (!open) $('open-library').focus();
    }
    updateLibraryControl(open);
}
function updateLibraryControl(open) {
    const control = $('open-library');
    const label = (open ? 'Hide' : 'Show') + ' conversation history';
    control.setAttribute('aria-expanded', String(open));
    control.setAttribute('aria-label', label);
    control.title = label;
}
function renderComposer() {
    updateDepthDescription();
    const busy = Boolean(state.run || state.submitting);
    $('message').readOnly = state.submitting;
    for (const control of document.querySelectorAll('#composer .shortcuts button, #composer input[name="research-depth"], #depth')) control.disabled = state.submitting;
    $('attach').disabled = state.submitting || (uiParental.enabled && !uiParental.pdfUploads);
    $('attach').title = uiParental.enabled && !uiParental.pdfUploads ? 'PDF uploads are disabled in parental controls.' : 'Attach a PDF';
    for (const radio of document.querySelectorAll('[name="research-depth"]')) radio.checked = radio.value === $('depth').value;
    $('send').hidden = Boolean(state.run);
    $('send').disabled = busy;
    $('stop').hidden = !state.run;
    $('stop').disabled = false;
    const chips = $('draft-chips');
    chips.replaceChildren();
    for (const control of document.querySelectorAll('[data-mode]')) control.setAttribute('aria-pressed', String(control.dataset.mode === state.mode));
    if (controls[state.mode]) {
        const summary = Object.values(state.filters).filter(Boolean).join(' · ');
        chips.append(button(kindName[state.mode] + (summary ? ' · ' + summary : ' · Edit filters'), () => showFilters(state.mode), 'quiet', 'sliders'));
        const remove = button('', () => { state.mode = 'auto'; state.filters = {}; renderComposer(); }, 'quiet', 'x');
        remove.setAttribute('aria-label', 'Clear research filters');
        chips.append(remove);
    }
    if (state.file) {
        const remove = button('PDF · ' + state.file.name, () => { state.file = null; $('file').value = ''; renderComposer(); }, 'quiet', 'paperclip');
        remove.setAttribute('aria-label', 'Remove PDF ' + state.file.name);
        chips.append(remove);
    }
    chips.hidden = !chips.children.length;
}
function resetDraft() {
    $('message').value = '';
    $('file').value = '';
    $('depth').value = uiPreferences.defaultDepth;
    state.mode = 'auto';
    state.filters = {};
    state.file = null;
    state.clientId = null;
}
function showFilters(mode, question) {
    const previous = state.mode === mode ? state.filters : {};
    const fields = $('filter-fields');
    labelWithIcon($('filters-title'), kindName[mode] + ' filters', mode === 'jobs' ? 'briefcase' : 'shopping');
    $('filters-form').querySelector('.dialog-note').textContent = question || 'Add the details that matter to you.';
    $('filters-form').dataset.mode = mode;
    fields.replaceChildren();
    for (const field of controls[mode]) {
        const label = element('label');
        labelWithIcon(label, field, /location|country/.test(field) ? 'globe' : 'sliders');
        const input = element(field === 'work style' ? 'select' : 'input');
        input.name = field;
        if (input.tagName === 'SELECT') {
            for (const value of ['', 'Remote', 'Hybrid', 'On-site']) {
                const option = element('option', value || 'Any work style');
                option.value = value;
                input.append(option);
            }
        } else {
            input.maxLength = 160;
            const placeholders = { role: 'Frontend developer', location: 'Country or city', product: 'Model or category',
                'delivery country': 'Country', budget: 'Maximum amount', currency: 'e.g. TND, EUR, USD', experience: 'Any level' };
            input.placeholder = placeholders[field] || 'Optional';
        }
        input.value = previous[field] || '';
        label.append(input);
        fields.append(label);
    }
    $('filters-dialog').showModal();
}
function sourceEvidence(report, reference) {
    const source = report.sources[reference.source - 1];
    if (!source) return;
    const target = $('evidence-content');
    target.replaceChildren(element('h3', source.title));
    const details = [source.snippetOnly ? 'Search snippet' : '',
        source.publishedAt ? 'Published ' + (dateLabel(source.publishedAt) || source.publishedAt) : '',
        source.checkedAt ? 'Retrieved ' + dateLabel(source.checkedAt) : ''].filter(Boolean);
    if (details.length) target.append(element('p', details.join(' · ')));
    const parts = reference.passage ? [source.passages[reference.passage - 1]].filter(Boolean) : source.passages;
    for (const passage of parts) {
        if (passage.page) target.append(element('p', 'Page ' + passage.page));
        if (reference.quote) target.append(element('blockquote', reference.quote), element('p', 'Full passage'));
        target.append(element('blockquote', passage.text));
    }
    const link = externalLink('Open original source ↗', source.url);
    if (link) target.append(link);
    $('evidence-dialog').showModal();
}
function cite(report, reference) {
    const control = button(String(reference.source), () => sourceEvidence(report, reference), 'cite');
    control.setAttribute('aria-label', 'Inspect evidence from source ' + reference.source);
    return control;
}
function fieldValue(container, report, field) {
    container.textContent = field?.text || 'Not stated';
    if (field) container.append(cite(report, field));
}
function compare(report, listings) {
    const fields = columns[report.kind];
    const table = element('table');
    const head = table.createTHead().insertRow();
    for (const title of ['Field', ...listings.map(item => item.fields[fields[0]].text)]) {
        const cell = element('th', title);
        cell.scope = 'col';
        head.append(cell);
    }
    const body = table.createTBody();
    for (const field of fields.slice(1)) {
        const row = body.insertRow();
        const label = element('th', field);
        label.scope = 'row';
        row.append(label);
        for (const item of listings) fieldValue(row.insertCell(), report, item.fields[field]);
    }
    const stack = element('div', null, 'compare-stack');
    for (const item of listings) {
        const card = element('article', null, 'compare-card');
        card.append(element('h3', item.fields[fields[0]].text));
        const details = element('dl');
        for (const field of fields.slice(1)) {
            const value = element('dd');
            fieldValue(value, report, item.fields[field]);
            details.append(element('dt', field), value);
        }
        card.append(details);
        stack.append(card);
    }
    $('comparison-content').replaceChildren(table, stack);
    $('comparison-dialog').showModal();
}
function renderReport(wrapper, message) {
    const report = message.report;
    if (!report) return;
    for (const assessment of report.assessments || []) {
        const note = element('p', (assessment.conflict ? 'Sources disagree: ' : 'Atlas assessment: ') + assessment.text, 'assessment');
        for (const reference of assessment.evidence) note.append(cite(report, reference));
        wrapper.append(note);
    }
    if (report.findings.length) {
        const findings = element('ul', null, 'findings');
        for (const finding of report.findings) {
            const item = element('li', finding.text);
            item.append(cite(report, finding));
            findings.append(item);
        }
        wrapper.append(findings);
    }
    if (report.listings.length) {
        const results = element('div', null, 'results');
        const selected = new Set();
        const fields = columns[report.kind];
        const compareControl = button('Compare results', () => compare(report, [...selected]), 'quiet', 'columns');
        compareControl.disabled = true;
        for (const listing of report.listings) {
            const card = element('article', null, 'result');
            const source = report.sources[listing.source - 1];
            const header = element('header');
            const title = element('h3', listing.fields[fields[0]].text);
            title.append(cite(report, listing.fields[fields[0]]));
            const checkLabel = element('label', null, 'compare-checkbox');
            const checkbox = element('input');
            checkbox.type = 'checkbox';
            checkbox.setAttribute('aria-label', 'Compare ' + listing.fields[fields[0]].text);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked && selected.size === 3) {
                    checkbox.checked = false;
                    feedback('Choose up to three results to compare.');
                    return;
                }
                if (checkbox.checked) selected.add(listing);
                else selected.delete(listing);
                compareControl.disabled = selected.size < 2;
                labelWithIcon(compareControl, 'Compare results (' + selected.size + ')', 'columns');
            });
            checkLabel.append(checkbox, document.createTextNode('Compare'));
            header.append(title, checkLabel);
            const details = element('dl');
            for (const field of fields.slice(1)) {
                const value = element('dd');
                fieldValue(value, report, listing.fields[field]);
                details.append(element('dt', field), value);
            }
            const footer = element('footer');
            const link = externalLink(report.kind === 'jobs' ? 'View vacancy ↗' : 'View offer ↗', source?.url);
            if (link) footer.append(link);
            footer.append(element('span', 'Retrieved ' + dateLabel(source?.checkedAt) + (source?.snippetOnly ? ' · Snippet only' : '')));
            card.append(header, details, footer);
            results.append(card);
        }
        if (report.listings.length > 1) results.append(compareControl);
        wrapper.append(results);
    }
    if (report.sources.length) {
        const section = element('details', null, 'sources');
        const heading = element('summary');
        labelWithIcon(heading, 'Sources · ' + report.sources.length, 'file');
        section.append(heading);
        for (const [index, source] of report.sources.entries()) {
            section.append(button((index + 1) + '. ' + source.title, () => sourceEvidence(report, { source: index + 1 }), 'quiet', 'file'));
        }
        wrapper.append(section);
        const appendix = element('section', null, 'print-sources');
        appendix.append(element('h3', 'Sources'));
        for (const [index, source] of report.sources.entries()) {
            appendix.append(element('p', '[' + (index + 1) + '] ' + source.title + (source.url ? ' · ' + source.url : '')));
            for (const passage of source.passages) {
                appendix.append(element('blockquote', (passage.page ? 'Page ' + passage.page + ' · ' : '') + passage.text));
            }
        }
        wrapper.append(appendix);
    }
    if (['jobs', 'marketplace', 'research'].includes(report.kind) && !state.run && !state.submitting) {
        const footer = element('div', null, 'answer-tools');
        footer.append(button('Refresh research', () => submit(message.id), 'quiet', 'refresh'));
        wrapper.append(footer);
    }
}
function messageNode(message) {
    const user = message.role === 'user';
    const article = element('article', null, 'turn ' + (user ? 'user' : 'assistant'));
    article.setAttribute('aria-label', user ? 'Your message' : 'Atlas reply');
    if (!user) {
        const avatar = element('span', null, 'turn-avatar');
        avatar.setAttribute('aria-hidden', 'true');
        avatar.append(icon('echo'));
        article.append(avatar);
    }
    const body = element('div', null, 'turn-body');
    if (message.text) body.append(element('p', message.text, 'message-text'));
    if (message.attachment) body.append(element('p', 'PDF · ' + message.attachment, 'attachment'));
    if (message.filters && Object.keys(message.filters).length) body.append(element('p', Object.values(message.filters).join(' · '), 'attachment'));
    renderReport(body, message);
    if (!user && message.report?.depth) {
        const report = message.report;
        const method = element('details', null, 'answer-method');
        const reviewed = report.verification?.status === 'reviewed';
        method.append(element('summary', (report.depth === 'detailed' ? 'Detailed' : 'Quick') +
            (reviewed ? ' · Evidence reviewed' : report.verification?.status === 'partial' ? ' · Review incomplete' : '')));
        const models = [...new Set((report.usage?.models || []).map(item => item.provider + ' / ' + item.model))];
        if (models.length) method.append(element('p', 'Models used: ' + models.join(', ')));
        method.append(element('p', (report.usage?.calls || 0) + ' model call(s)' + (report.sources?.length ?
            ' · ' + (report.usage?.searches || 0) + ' search(es) · ' + report.sources.length + ' saved source(s)' : '')));
        if (report.verification?.note) method.append(element('p', report.verification.note));
        if (report.usage?.truncated) method.append(element('p', 'The answer reached its length limit. Ask Atlas to continue if needed.'));
        body.append(method);
    }
    article.append(body);
    return article;
}
function render({ replyId, animateSent = false } = {}) {
    const messages = state.chat?.messages || [];
    const visible = Boolean(messages.length || state.run);
    $('welcome').hidden = visible;
    $('transcript').hidden = !visible;
    $('chat-actions').hidden = !state.chat;
    $('archive').hidden = !state.chat || state.chat.archived === true;
    $('transcript').replaceChildren(...messages.map(message => {
        const node = messageNode(message);
        if (replyId && message.id === replyId) node.classList.add('turn-enter');
        return node;
    }));
    if (state.run) {
        if (state.run.userMessage && !messages.some(item => item.id === state.run.userMessage.id)) {
            const node = messageNode(state.run.userMessage);
            if (animateSent) node.classList.add('turn-enter');
            $('transcript').append(node);
        }
        const stage = element('div', state.run.stage || 'Preparing the reply', 'progress');
        stage.id = 'progress-stage';
        stage.setAttribute('role', 'status');
        stage.append(element('span', null, 'elapsed'));
        $('transcript').append(stage);
    }
    renderHistory();
    renderComposer();
}
function leaveView() {
    state.view++;
    state.run = null;
    state.submitting = false;
    state.draft = null;
    resetDraft();
    feedback();
}
function newChat() {
    leaveView();
    state.chat = null;
    render();
    if (mobile.matches) library(false);
    $('message').focus();
}
function goHome() {
    newChat();
    loadHistory();
}
async function openChat(id) {
    leaveView();
    const view = state.view;
    try {
        const chat = await api('/conversations/' + id);
        if (view !== state.view) return;
        state.chat = chat;
        if (chat.archived) feedback('This chat is archived. Restore it in Settings to continue the conversation.');
        if (mobile.matches) library(false);
        if (chat.run) watch(chat.run, view);
        else { render(); scrollBottom(); }
    } catch (error) {
        if (view === state.view) { render(); explainError(error); }
    }
}
async function watch(id, view, userMessage) {
    state.run = { id, userMessage, started: Date.now() };
    render({ animateSent: Boolean(userMessage) });
    scrollBottom();
    for (let failures = 0; view === state.view && state.run?.id === id;) {
        try {
            const data = await api('/runs/' + id);
            if (view !== state.view) return;
            if (data.state !== 'running') {
                const draft = state.draft;
                state.run = null;
                state.draft = null;
                if (data.report) {
                    const chat = await api('/conversations/' + state.chat.id).catch(() => null);
                    if (view !== state.view) return;
                    if (chat) state.chat = chat;
                    if (!state.chat.messages.some(item => item.id === id)) {
                        state.chat.messages.push(data.userMessage, { id, role: 'assistant', text: data.report.text, report: data.report });
                    }
                    if (data.state !== 'completed' && draft) {
                        restoreDraft(draft, Boolean(chat?.messages.some(item => item.id === id)));
                    }
                    loadHistory();
                } else if (draft) restoreDraft(draft);
                render({ replyId: data.report ? id : undefined });
                scrollBottom();
                if (data.state === 'completed' && data.report) notifyReply(data.report.text);
                if (data.error) explainError({ message: data.error, retryAfter: data.retryAfter });
                return;
            }
            failures = 0;
            if (!state.run.userMessage && data.userMessage) {
                state.run.userMessage = data.userMessage;
                render();
                scrollBottom();
            }
            const progress = $('progress-stage');
            if (progress.firstChild?.nodeValue !== data.stage) progress.firstChild.nodeValue = data.stage;
            progress.querySelector('.elapsed').textContent = Math.floor((Date.now() - data.started) / 1000) + 's';
        } catch (error) {
            if (view !== state.view) return;
            if (++failures >= 3) {
                state.run = null;
                if (state.draft) restoreDraft(state.draft);
                state.draft = null;
                render();
                explainError(error);
                return;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 850));
    }
}
function restoreDraft(draft, saved = false) {
    if (draft.refresh || $('message').value || state.file || state.mode !== 'auto') return;
    $('message').value = draft.text;
    $('depth').value = draft.depth;
    state.mode = draft.mode;
    state.filters = draft.filters;
    state.file = draft.file;
    state.clientId = saved ? null : draft.clientId;
}
async function submit(refresh = '') {
    if (state.run || state.submitting) return;
    if (state.chat?.archived) { feedback('Restore this chat from Settings → Archived chats before sending another message.'); return; }
    const draft = { text: $('message').value.trim(), mode: state.mode, depth: $('depth').value,
        filters: state.filters, file: state.file, refresh, clientId: refresh ? crypto.randomUUID() : state.clientId || crypto.randomUUID() };
    if (!draft.text && !draft.file && !refresh && !draft.filters.role && !draft.filters.product) {
        feedback('Enter a message or add search details.');
        $('message').focus();
        return;
    }
    const view = state.view;
    state.submitting = true;
    feedback();
    renderComposer();
    try {
        if (!state.chat) {
            const chat = await api('/conversations', { method: 'POST' });
            if (view !== state.view) return;
            state.chat = chat;
        }
        const form = new FormData();
        for (const key of ['text', 'mode', 'depth', 'clientId', 'refresh']) form.append(key, draft[key]);
        form.append('filters', JSON.stringify(draft.filters));
        if (draft.file && !refresh) form.append('file', draft.file);
        const result = await api('/conversations/' + state.chat.id + '/messages', { method: 'POST', body: form });
        if (view !== state.view) return;
        state.submitting = false;
        if (!refresh) resetDraft();
        if (result.saved) {
            await openChat(state.chat.id);
            return;
        }
        state.draft = draft;
        watch(result.run, view, refresh ? null : { role: 'user', text: draft.text || draft.filters.role || draft.filters.product || 'Summarize this PDF.',
            filters: draft.filters, attachment: draft.file?.name });
    } catch (error) {
        if (view !== state.view) return;
        state.submitting = false;
        if (!refresh) state.clientId = draft.clientId;
        renderComposer();
        explainError(error);
        if (error.clarification) showFilters(error.clarification.mode, error.message);
    }
}
function exportMarkdown() {
    const lines = ['# ' + state.chat.title];
    for (const message of state.chat.messages) {
        lines.push('', '## ' + (message.role === 'user' ? 'You' : 'Atlas'), '', message.text || '');
        const report = message.report;
        if (!report) continue;
        for (const finding of report.findings) lines.push('- ' + finding.text + ' [' + finding.source + ']');
        for (const note of report.assessments || []) {
            lines.push('- ' + (note.conflict ? 'Sources disagree: ' : 'Atlas assessment: ') + note.text +
                ' ' + note.evidence.map(reference => '[' + reference.source + ']').join(' '));
        }
        for (const listing of report.listings) {
            lines.push('');
            for (const [label, field] of Object.entries(listing.fields)) lines.push('- ' + label + ': ' + field.text + ' [' + field.source + ']');
        }
        for (const [index, source] of report.sources.entries()) {
            lines.push('', '[' + (index + 1) + '] ' + source.title + ' ' + source.url + ' (retrieved ' + dateLabel(source.checkedAt) + ')');
            for (const passage of source.passages) lines.push('> ' + (passage.page ? 'Page ' + passage.page + ': ' : '') + passage.text);
        }
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = 'atlas-' + state.chat.id + '.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let accountUser = null;
let accountMode = 'signin';
let accountBusy = false;
let pendingVerification = null;
let verificationTimer = null;
let providerState = 'loading';
const authProviders = [
    { id: 'google', name: 'Google', enabled: false },
    { id: 'github', name: 'GitHub', enabled: false },
    { id: 'microsoft', name: 'Microsoft', enabled: false }
];
const providerMarks = {
    google: '<path fill="#4285F4" d="M21.8 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.4c2-1.8 2.9-4.5 2.9-7.7Z"/><path fill="#34A853" d="M12 22c2.8 0 5.1-.9 6.9-2.5l-3.4-2.6c-.9.6-2 1-3.5 1-2.7 0-5-1.9-5.8-4.4H2.7v2.7A10.4 10.4 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.2 13.5a6.1 6.1 0 0 1 0-3V7.8H2.7a10 10 0 0 0 0 8.4l3.5-2.7Z"/><path fill="#EA4335" d="M12 6.1c1.5 0 2.8.5 3.9 1.5l2.9-2.9A10 10 0 0 0 2.7 7.8l3.5 2.7C7 8 9.3 6.1 12 6.1Z"/>',
    github: '<path fill="currentColor" d="M12 .9a11.1 11.1 0 0 0-3.5 21.6c.6.1.8-.2.8-.5v-2.1c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 1.7 2.6 1.2 3.3.9.1-.7.4-1.2.7-1.5-2.6-.3-5.2-1.3-5.2-5.6 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.5.1-3.1 0 0 .9-.3 3.1 1.1a10.7 10.7 0 0 1 5.7 0c2.2-1.4 3.1-1.1 3.1-1.1.6 1.6.2 2.8.1 3.1.7.8 1.1 1.8 1.1 3 0 4.3-2.6 5.3-5.2 5.6.4.4.8 1.1.8 2.1V22c0 .3.2.6.8.5A11.1 11.1 0 0 0 12 .9Z"/>',
    microsoft: '<path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M13 1h10v10H13z"/><path fill="#00a4ef" d="M1 13h10v10H1z"/><path fill="#ffb900" d="M13 13h10v10H13z"/>',
};
const oauthErrors = {
    cancelled: 'Sign-in was cancelled. You can try again.',
    expired: 'That sign-in request expired. Please try again.',
    provider_failed: 'The sign-in provider could not complete the request. Please try again.',
    email_unavailable: 'This provider did not share a verified email address. Try another sign-in method.',
    email_conflict: 'An account already uses this email. Sign in to that account, then connect this provider from Your account.',
    terms_required: 'Please agree to the Terms and Conditions to create your account.',
    registration_closed: 'New account registration is currently closed.',
    account_unavailable: 'This account is currently unavailable.',
    link_conflict: 'This sign-in method is already connected to another account.',
    link_expired: 'Please sign in again before connecting another sign-in method.',
    unavailable: 'This sign-in option is currently unavailable.'
};

function providerIcon(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('provider-mark');
    svg.innerHTML = providerMarks[id];
    return svg;
}
function announceAccountChange() {
    try { localStorage.setItem('atlas-account-change', String(Date.now())); } catch { /* Same-tab sign-in remains available. */ }
}
function applyProfile(user) {
    const identity = user?.id || null;
    const changed = identity !== state.identity;
    if (changed) {
        pendingVerification = null;
        clearInterval(verificationTimer); verificationTimer = null;
        state.requests.abort();
        state.requests = new AbortController();
        state.identity = identity;
        uiParental = { enabled: false, webResearch: true, pdfUploads: true, contentFilter: false };
        applyPreferences(cachedPreferences(identity));
        state.history = [];
        state.historyError = '';
        $('history-search').value = '';
        newChat();
        loadHistory();
    }
    accountUser = user;
    $('identity').textContent = user ? 'Signed in' : 'Guest';
    $('signin').hidden = Boolean(user);
    $('signup').hidden = Boolean(user);
    $('account').hidden = !user;
    $('account-name').textContent = user?.name || 'Account';
    $('admin-link').hidden = !user?.isAdmin;
    window.AtlasAccount?.updateUser(user);
    if (changed && $('account-dialog').open) renderAccount();
}
async function initAccounts() {
    try {
        const profile = await api('/profile');
        applyProfile(profile.user || null);
    } catch (error) {
        if (error.name !== 'AbortError') feedback('Account access is temporarily unavailable. Try again shortly.');
    }
}
async function initAuthProviders(retry = true) {
    try {
        const data = await api('/auth/providers');
        for (const provider of authProviders) provider.enabled = data.providers?.some(item => item.id === provider.id && item.enabled === true) || false;
        providerState = 'ready';
    } catch (error) {
        if (error.name === 'AbortError') {
            if (retry) return initAuthProviders(false);
            return;
        }
        providerState = 'error';
    }
    renderAuthProviders();
}
function renderAuthProviders() {
    for (const area of document.querySelectorAll('[data-auth-providers]')) {
        const linking = area.dataset.authProviders === 'link';
        const grid = element('div', null, 'provider-grid');
        for (const provider of authProviders) {
            const connected = linking && accountUser?.providers?.includes(provider.id);
            const control = button('', () => startOAuth(provider.id), 'provider-button');
            control.dataset.oauth = provider.id;
            control.append(providerIcon(provider.id), element('span', connected ? provider.name + ' · Connected' : (linking ? 'Connect ' : 'Continue with ') + provider.name));
            control.disabled = accountBusy || !provider.enabled || Boolean(connected);
            if (connected) {
                control.classList.add('provider-connected');
                control.append(icon('check'));
                control.title = provider.name + ' is connected to your account';
            } else if (!provider.enabled) control.title = providerState === 'loading' ? 'Checking availability' : 'This sign-in option is not configured yet';
            grid.append(control);
        }
        const message = providerState === 'loading' ? 'Checking sign-in options…' : providerState === 'error' ? 'Other sign-in options are temporarily unavailable.' : authProviders.every(item => !item.enabled) ? 'Social sign-in is not configured yet.' : authProviders.some(item => !item.enabled) ? 'More sign-in options are being configured.' : '';
        area.replaceChildren(grid);
        if (message) area.append(element('p', message, 'provider-availability'));
    }
}
function setAccountBusy(busy) {
    accountBusy = busy;
    for (const control of document.querySelectorAll('#account-mount button:not([data-oauth]), [data-auth]')) control.disabled = busy;
    renderAuthProviders();
    updateVerificationCountdown();
}
function updateVerificationCountdown() {
    const control = document.querySelector('[data-resend-verification]');
    if (!control || !pendingVerification) return;
    const seconds = Math.max(0, Math.ceil((pendingVerification.resendAt - Date.now()) / 1000));
    control.disabled = accountBusy || seconds > 0;
    control.textContent = seconds ? 'Resend code in ' + seconds + 's' : 'Resend code';
}
function showVerification(data) {
    pendingVerification = { ...data, resendAt: Date.now() + data.resendAfter * 1000 };
    accountMode = 'verify';
    renderAccount();
    if (!$('account-dialog').open) $('account-dialog').showModal();
}
function renderVerification(mount, status) {
    mount.append(element('p', 'Enter the six-digit code sent to ' + pendingVerification.email + '.', 'verification-description'));
    mount.append(element('p', 'The code expires in 10 minutes. Check your spam folder if it has not arrived.', 'auth-help'));
    const form = element('form', null, 'auth-form verification-form');
    const input = accountField(form, 'Verification code', 'code', 'text', 'one-time-code');
    input.inputMode = 'numeric'; input.pattern = '[0-9]{6}'; input.minLength = 6; input.maxLength = 6;
    input.classList.add('verification-code');
    const confirm = button('Verify email and continue', null, 'primary auth-submit', 'shield');
    confirm.type = 'submit';
    form.append(status, confirm);
    const resend = button('Resend code', async () => {
        if (accountBusy || resend.disabled) return;
        setAccountBusy(true); status.textContent = '';
        try {
            const data = await api('/auth/verification/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ verificationId: pendingVerification.id }) });
            pendingVerification = { ...data.verification, resendAt: Date.now() + data.verification.resendAfter * 1000 };
            input.value = ''; status.textContent = 'A new code was sent. Use the most recent email.'; input.focus();
        } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
        finally { setAccountBusy(false); }
    }, 'quiet');
    resend.dataset.resendVerification = '';
    const change = button('Use a different email', () => { pendingVerification = null; openAccount('signup'); }, 'quiet');
    const actions = element('div', null, 'verification-actions'); actions.append(resend, change);
    form.append(actions); mount.append(form);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (accountBusy || !form.reportValidity()) return;
        setAccountBusy(true); status.textContent = '';
        try {
            const result = await api('/auth/verification/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ verificationId: pendingVerification.id, code: input.value.trim() }) });
            pendingVerification = null; clearInterval(verificationTimer); verificationTimer = null;
            $('account-dialog').close(); form.reset(); applyProfile(result.user); announceAccountChange();
            feedback('Email verified. Welcome to Atlas.');
        } catch (error) { if (error.name !== 'AbortError') { status.textContent = error.message; input.select(); } }
        finally { setAccountBusy(false); }
    });
    updateVerificationCountdown(); verificationTimer = setInterval(updateVerificationCountdown, 1000);
    input.focus();
}
async function startOAuth(providerId) {
    if (accountBusy || !authProviders.some(item => item.id === providerId && item.enabled)) return;
    const linking = Boolean(accountUser);
    const terms = $('account-mount').querySelector('[name="acceptTerms"]');
    const status = $('account-mount').querySelector('.auth-status');
    if (!linking && accountMode === 'signup' && !terms?.reportValidity()) return;
    const password = $('account-mount').querySelector('.oauth-link-form [name="currentPassword"]');
    if (linking && accountUser.hasPassword !== false && !password?.reportValidity()) return;
    const payload = { acceptTerms: linking || Boolean(terms?.checked), link: linking };
    if (linking && password) payload.currentPassword = password.value;
    setAccountBusy(true);
    status.textContent = 'Opening ' + authProviders.find(item => item.id === providerId).name + '…';
    try {
        const data = await api('/auth/oauth/' + providerId + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const destination = new URL(data.url);
        if (destination.protocol !== 'https:') throw new Error('The sign-in provider returned an invalid address. Please try again.');
        window.location.assign(destination.href);
    } catch (error) {
        if (error.name !== 'AbortError') status.textContent = error.message;
    } finally { setAccountBusy(false); }
}
function accountField(form, labelText, name, type, autocomplete) {
    const label = element('label', labelText, 'auth-field');
    const input = element('input');
    input.name = name;
    input.type = type;
    input.autocomplete = autocomplete;
    input.required = name !== 'name';
    if (type === 'password') {
        input.minLength = 12;
        input.maxLength = 128;
    } else input.maxLength = name === 'name' ? 80 : 254;
    label.append(input);
    form.append(label);
    return input;
}
function renderAccount() {
    clearInterval(verificationTimer); verificationTimer = null;
    const signedIn = Boolean(accountUser);
    const verifying = !signedIn && accountMode === 'verify' && Boolean(pendingVerification);
    const signup = accountMode === 'signup' && !signedIn;
    labelWithIcon($('account-title'), verifying ? 'Verify your email' : signedIn ? 'Your account' : signup ? 'Create your Atlas account' : 'Sign in to Atlas',
        signedIn ? 'user' : signup ? 'user-plus' : 'login');
    $('account-dialog').querySelector('.auth-switch').hidden = signedIn || verifying;
    for (const tab of document.querySelectorAll('[data-auth]')) tab.setAttribute('aria-pressed', String(tab.dataset.auth === accountMode));
    const mount = $('account-mount');
    mount.replaceChildren();
    const status = element('p', '', 'auth-status');
    status.setAttribute('role', 'status');
    if (verifying) { renderVerification(mount, status); return; }
    if (signedIn) {
        mount.append(element('p', accountUser.email, 'account-email'));
        if (accountUser.isAdmin) {
            const admin = element('a', 'Open admin dashboard', 'primary admin-dashboard-link');
            admin.href = '/atlas/admin';
            admin.prepend(icon('shield'));
            mount.append(admin);
        }
        const linking = element('form', null, 'auth-form oauth-link-form');
        linking.append(element('h3', 'Connected sign-in methods'));
        if (accountUser.hasPassword !== false) {
            accountField(linking, 'Confirm password to connect an account', 'currentPassword', 'password', 'current-password');
        } else linking.append(element('p', 'Connect another provider while you are signed in.', 'auth-help'));
        const providers = element('div', null, 'auth-providers');
        providers.dataset.authProviders = 'link';
        linking.append(providers);
        linking.addEventListener('submit', event => event.preventDefault());
        mount.append(linking);
        if (accountUser.hasPassword !== false) {
            const form = element('form', null, 'auth-form password-form');
            form.append(element('h3', 'Change password'));
            accountField(form, 'Current password', 'currentPassword', 'password', 'current-password');
            accountField(form, 'New password', 'newPassword', 'password', 'new-password');
            const save = element('button', 'Update password', 'primary');
            save.type = 'submit';
            form.append(save);
            form.addEventListener('submit', async event => {
                event.preventDefault();
                if (accountBusy || !form.reportValidity()) return;
                setAccountBusy(true);
                status.textContent = '';
                try {
                    await api('/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(Object.fromEntries(new FormData(form))) });
                    form.reset();
                    status.textContent = 'Password updated.';
                } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
                finally { setAccountBusy(false); }
            });
            mount.append(form);
        }
        const logout = button('Sign out', async () => {
            if (accountBusy) return;
            setAccountBusy(true);
            try {
                await api('/auth/logout', { method: 'POST' });
                $('account-dialog').close();
                applyProfile(null);
                announceAccountChange();
            } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
            finally { setAccountBusy(false); }
        }, 'quiet signout-button', 'login');
        mount.append(logout, status);
        renderAuthProviders();
        return;
    }
    const form = element('form', null, 'auth-form');
    form.id = 'atlas-account-form';
    if (signup) {
        const label = element('label', null, 'terms-choice');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'acceptTerms';
        checkbox.required = true;
        checkbox.setAttribute('form', form.id);
        const text = element('span', 'I agree to the ');
        const link = element('a', 'Terms and Conditions');
        link.href = '/atlas/terms';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        text.append(link);
        label.append(checkbox, text);
        mount.append(label);
    }
    const providers = element('div', null, 'auth-providers');
    providers.dataset.authProviders = 'signin';
    mount.append(providers, element('div', 'or use your email', 'auth-divider'));
    if (signup) accountField(form, 'Name (optional)', 'name', 'text', 'name');
    accountField(form, 'Email address', 'email', 'email', 'email');
    accountField(form, 'Password', 'password', 'password', signup ? 'new-password' : 'current-password');
    if (signup) form.append(element('p', 'Use 12–128 characters for your password. We’ll email a code to verify your address.', 'auth-hint'));
    const submitButton = element('button', null, 'primary auth-submit');
    submitButton.type = 'submit';
    labelWithIcon(submitButton, signup ? 'Create account' : 'Sign in', signup ? 'user-plus' : 'login');
    form.append(status, submitButton);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (accountBusy || !form.reportValidity()) return;
        setAccountBusy(true);
        status.textContent = '';
        const values = Object.fromEntries(new FormData(form));
        const payload = signup ? { ...values, acceptTerms: values.acceptTerms === 'on' } : values;
        try {
            const data = await api(signup ? '/auth/register' : '/auth/login', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (data.verification) { form.reset(); showVerification(data.verification); return; }
            $('account-dialog').close();
            form.reset();
            applyProfile(data.user);
            announceAccountChange();
        } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
        finally { setAccountBusy(false); }
    });
    mount.append(form);
    renderAuthProviders();
}
function openAccount(mode) {
    if (accountBusy) return;
    accountMode = pendingVerification && ['signin', 'signup'].includes(mode) ? 'verify' : mode;
    renderAccount();
    if (!$('account-dialog').open) $('account-dialog').showModal();
}
async function initializeAccountAccess() {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('auth');
    const reason = url.searchParams.get('reason');
    if (outcome) {
        url.searchParams.delete('auth');
        url.searchParams.delete('reason');
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    await initAccounts();
    initAuthProviders();
    if (!accountUser) {
        try {
            const pending = await api('/auth/verification');
            if (pending.verification) showVerification(pending.verification);
        } catch { /* The normal sign-in form remains available if storage is unavailable. */ }
    }
    if (!outcome) return;
    if (outcome === 'success' || outcome === 'linked') {
        if (!accountUser) {
            openAccount('signin');
            $('account-mount').querySelector('.auth-status').textContent = 'Your sign-in session is unavailable. Please sign in again.';
            return;
        }
        announceAccountChange();
        feedback(outcome === 'linked' ? 'Sign-in method connected to your account.' : 'You are signed in. Welcome to Atlas.');
    } else if (outcome === 'error') {
        const message = oauthErrors[reason] || 'Sign-in could not be completed. Please try again.';
        openAccount(reason === 'terms_required' ? 'signup' : accountUser ? 'account' : 'signin');
        $('account-mount').querySelector('.auth-status').textContent = message;
        feedback(message);
    }
}

$('composer').addEventListener('submit', event => { event.preventDefault(); submit(); });
$('message').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && uiPreferences.enterToSend) { event.preventDefault(); submit(); }
});
$('message').addEventListener('input', () => { state.clientId = null; });
$('stop').addEventListener('click', async () => {
    if (!state.run) return;
    $('stop').disabled = true;
    try { await api('/runs/' + state.run.id, { method: 'DELETE' }); } catch (error) { explainError(error); }
});
$('attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => {
    const file = $('file').files[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
        $('file').value = '';
        feedback('Choose a PDF under 5 MB.');
        return;
    }
    state.file = file;
    state.clientId = null;
    feedback();
    renderComposer();
});
for (const control of document.querySelectorAll('[data-mode]')) control.addEventListener('click', () => showFilters(control.dataset.mode));
for (const control of document.querySelectorAll('[data-example]')) control.addEventListener('click', () => {
    if (controls[control.dataset.example]) showFilters(control.dataset.example);
    else { $('message').value = 'Explain '; $('message').focus(); }
});
$('filters-form').addEventListener('submit', event => {
    event.preventDefault();
    state.mode = event.currentTarget.dataset.mode;
    state.filters = Object.fromEntries([...new FormData(event.currentTarget)].filter(([, value]) => value.trim()));
    state.clientId = null;
    $('filters-dialog').close();
    feedback();
    renderComposer();
    $('message').focus();
});
for (const control of document.querySelectorAll('[data-close]')) control.addEventListener('click', () => control.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) {
    const heading = dialog.querySelector('h2');
    heading.id ||= dialog.id + '-title';
    dialog.setAttribute('aria-labelledby', heading.id);
}
$('open-library').addEventListener('click', () => {
    const open = mobile.matches ? document.body.classList.contains('mobile-library-open') : !document.body.classList.contains('library-closed');
    library(!open);
});
$('hide-library').addEventListener('click', () => library(false));
$('close-library').addEventListener('click', () => library(false));
$('backdrop').addEventListener('click', () => library(false));
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('mobile-library-open')) library(false);
});
mobile.addEventListener('change', () => {
    document.body.classList.remove('mobile-library-open');
    document.querySelector('main').inert = false;
    $('backdrop').hidden = true;
    document.body.classList.toggle('library-closed', !desktopLibraryOpen);
    const open = !mobile.matches && desktopLibraryOpen;
    $('library').inert = !open;
    updateLibraryControl(open);
});
document.body.classList.toggle('library-closed', !desktopLibraryOpen);
$('library').inert = mobile.matches || !desktopLibraryOpen;
updateLibraryControl(!mobile.matches && desktopLibraryOpen);
for (const logo of document.querySelectorAll('[data-home]')) logo.addEventListener('click', goHome);
$('history-search').addEventListener('input', renderHistory);
$('clear-history-search').addEventListener('click', () => {
    $('history-search').value = '';
    renderHistory();
    $('history-search').focus();
});
$('history-search').addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.currentTarget.value) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.value = '';
        renderHistory();
    }
});
$('new-chat').addEventListener('click', newChat);
$('chat-actions').addEventListener('click', () => $('actions-dialog').showModal());
$('export').addEventListener('click', () => { $('actions-dialog').close(); exportMarkdown(); });
$('print').addEventListener('click', () => {
    $('actions-dialog').close();
    const details = [...document.querySelectorAll('#transcript details')].filter(item => !item.open);
    details.forEach(item => { item.open = true; });
    window.print();
    details.forEach(item => { item.open = false; });
});
$('delete').addEventListener('click', async () => {
    if (!state.chat || (uiPreferences.confirmBeforeDelete && !window.confirm('Delete this conversation and its saved evidence?'))) return;
    const view = state.view;
    try {
        await api('/conversations/' + state.chat.id, { method: 'DELETE' });
        if (view !== state.view) return;
        $('actions-dialog').close();
        newChat();
        loadHistory();
    } catch (error) { $('actions-dialog').close(); explainError(error); }
});
$('archive').addEventListener('click', async () => {
    if (!state.chat) return;
    const view = state.view;
    try {
        await api('/conversations/' + state.chat.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
        if (view !== state.view) return;
        $('actions-dialog').close();
        newChat();
        await loadHistory();
        feedback('Chat archived. You can restore it from Settings → Archived chats.');
    } catch (error) { $('actions-dialog').close(); explainError(error); }
});
$('signin').addEventListener('click', () => openAccount('signin'));
$('signup').addEventListener('click', () => openAccount('signup'));
for (const tab of document.querySelectorAll('[data-auth]')) {
    labelWithIcon(tab, tab.dataset.auth === 'signup' ? 'Sign up' : 'Sign in', tab.dataset.auth === 'signup' ? 'user-plus' : 'login');
    tab.addEventListener('click', () => openAccount(tab.dataset.auth));
}
$('account-dialog').addEventListener('close', () => { clearInterval(verificationTimer); verificationTimer = null; $('account-mount').replaceChildren(); });
window.addEventListener('storage', event => { if (event.key === 'atlas-account-change') initAccounts(); });
window.addEventListener('focus', initAccounts);
function updateDepthDescription() {
    const note = $('depth-description');
    if (note) note.textContent = $('depth').value === 'detailed' ?
        'Detailed · Stronger reasoning, more context, and an extra evidence review for research.' :
        'Quick · Faster answers and focused research.';
}
for (const radio of document.querySelectorAll('[name="research-depth"]')) radio.addEventListener('change', () => { $('depth').value = radio.value; updateDepthDescription(); });
function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme').setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
    $('theme').title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    $('theme').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
}
function cachedPreferences(identity) {
    try {
        const saved = JSON.parse(localStorage.getItem('atlas-preferences:' + (identity || 'guest')) || '{}');
        if (!identity && !saved.theme) saved.theme = localStorage.getItem('atlas-theme') || 'system';
        return saved;
    } catch { return {}; }
}
function applyPreferences(values) {
    const next = { ...preferenceDefaults };
    const choices = { defaultDepth: ['quick', 'detailed'], theme: ['system', 'light', 'dark'], textSize: ['small', 'medium', 'large'], breakReminderMinutes: [0, 15, 30, 60] };
    for (const key of Object.keys(next)) {
        const value = values?.[key];
        if (choices[key] ? choices[key].includes(value) : typeof value === 'boolean') next[key] = value;
    }
    if (uiPreferences.breakReminderMinutes !== next.breakReminderMinutes) activeUseMs = 0;
    uiPreferences = next;
    const root = document.documentElement;
    root.dataset.textSize = next.textSize;
    root.dataset.backgroundMotion = String(next.backgroundMotion);
    root.dataset.reducedMotion = String(next.reducedMotion);
    setTheme(next.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : next.theme);
    if (!$('message').value && !state.run && !state.submitting) { $('depth').value = next.defaultDepth; renderComposer(); }
    try { localStorage.setItem('atlas-preferences:' + (state.identity || 'guest'), JSON.stringify(next)); } catch { /* Current preferences still apply. */ }
}
function notifyReply(text) {
    if (!uiPreferences.replyNotifications) return;
    feedback('Atlas has finished your reply.');
    if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
        try {
            const notice = new Notification('Atlas reply ready', { body: uiPreferences.notificationPreview ? String(text || '').slice(0, 160) : 'Open Atlas to read your reply.', icon: '/atlas-mark.svg', tag: 'atlas-reply' });
            notice.onclick = () => { window.focus(); notice.close(); };
        } catch { /* The in-app notification remains available. */ }
    }
}
applyPreferences(cachedPreferences(null));
$('theme').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    const previous = { ...uiPreferences };
    applyPreferences({ ...uiPreferences, theme });
    if (state.identity) api('/account/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) })
        .then(data => applyPreferences(data.preferences)).catch(error => { applyPreferences(previous); explainError(error); });
    else { try { localStorage.setItem('atlas-theme', theme); } catch { /* The theme still changes. */ } }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (uiPreferences.theme === 'system') applyPreferences(uiPreferences); });
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { lastInteraction = Date.now(); }, { passive: true });
setInterval(() => {
    if (!uiPreferences.breakReminderMinutes || document.visibilityState !== 'visible' || !document.hasFocus() || Date.now() - lastInteraction > 120_000) return;
    activeUseMs += 30_000;
    if (activeUseMs >= uiPreferences.breakReminderMinutes * 60_000) {
        activeUseMs = 0;
        feedback('You have been using Atlas for ' + uiPreferences.breakReminderMinutes + ' minutes. Take a moment for a break when you are ready.');
    }
}, 30_000);
window.AtlasAccount?.init({ api, icon, providerIcon, getProviders: () => authProviders,
    profileChanged: user => { applyProfile(user); announceAccountChange(); }, preferencesChanged: applyPreferences,
    parentalChanged: controls => {
        uiParental = controls;
        if (controls.enabled && !controls.pdfUploads && state.file) { state.file = null; $('file').value = ''; }
        renderComposer();
    },
    historyChanged: async options => {
        if (options?.deletedAll) newChat();
        else if (state.chat) {
            const current = await api('/conversations/' + state.chat.id).catch(() => null);
            if (!current) newChat(); else { state.chat = current; render(); }
        }
        await loadHistory();
    },
    openConversation: openChat,
    signedOut: () => { applyProfile(null); announceAccountChange(); }, feedback });
render();
loadHistory();
initializeAccountAccess();
