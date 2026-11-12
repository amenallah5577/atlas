'use strict';

const $ = id => document.getElementById(id);
const state = {
    users: [], conversations: [], userNext: '', conversationNext: '',
    userRequest: 0, conversationRequest: 0, detailRequest: 0,
    ownerId: '', selectedConversation: '', denied: false
};

function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined && text !== null) result.textContent = text;
    if (className) result.className = className;
    return result;
}

function action(text, callback, className = 'quiet') {
    const result = node('button', text, className);
    result.type = 'button';
    result.addEventListener('click', callback);
    return result;
}

function date(value) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Not recorded';
}

function feedback(text = '') {
    $('feedback').textContent = text;
}

function ownerOnly(error) {
    if (![401, 403].includes(error.status)) return false;
    state.denied = true;
    state.users = [];
    state.conversations = [];
    state.selectedConversation = '';
    $('users-list').replaceChildren();
    $('conversations-list').replaceChildren();
    $('detail-messages').replaceChildren();
    $('audit-list').replaceChildren();
    $('conversation-dialog').close();
    $('dashboard').hidden = true;
    $('access-description').textContent = error.status === 401 ?
        'Sign in with the owner account to view this page.' :
        'This account does not have owner access. Sign in with the owner account to continue.';
    $('access-message').hidden = false;
    return true;
}

function showError(error, target) {
    if (ownerOnly(error)) return;
    const message = error.name === 'AbortError' ? 'The request timed out. Try again.' : error.message;
    if (target) target.textContent = message;
    else feedback(message);
}

async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
        const headers = new Headers(options.headers);
        headers.set('Accept', 'application/json');
        if (options.body) headers.set('Content-Type', 'application/json');
        const response = await fetch('/api/atlas' + path, {
            ...options, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        if (response.status === 204) return null;
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.error || 'The administration request could not be completed.'), { status: response.status });
        return body;
    } finally {
        clearTimeout(timeout);
    }
}

function userId(user) {
    return user._id || user.id;
}

function accountLabel(owner) {
    const account = state.users.find(user => 'account:' + userId(user) === owner);
    if (account) return account.email;
    if (owner?.startsWith('guest:')) return 'Guest session · ' + owner.slice(-8);
    return owner ? 'Account · ' + owner.replace(/^account:/, '').slice(-8) : 'Unknown account';
}

function updateAccountFilter() {
    const select = $('conversation-owner');
    const selected = select.value;
    const previous = new Map([...select.options].map(option => [option.value, option.textContent]));
    select.replaceChildren(node('option', 'All accounts and guest sessions'));
    select.firstElementChild.value = '';
    for (const user of state.users) {
        const option = node('option', user.email + (user.name ? ' · ' + user.name : ''));
        option.value = 'account:' + userId(user);
        select.append(option);
    }
    if (selected && ![...select.options].some(option => option.value === selected)) {
        const option = node('option', previous.get(selected) || accountLabel(selected));
        option.value = selected;
        select.append(option);
    }
    select.value = selected;
}

async function loadOverview() {
    const overview = await api('/admin/overview');
    if (state.denied) return;
    $('user-count').textContent = Number.isFinite(overview.userCount) ? overview.userCount : '—';
    $('conversation-count').textContent = Number.isFinite(overview.conversationCount) ? overview.conversationCount : '—';
    $('storage-label').textContent = overview.storage === 'local' ? 'Local database' : 'MongoDB';
    $('registration-enabled').checked = overview.settings?.registrationEnabled !== false;
    $('research-enabled').checked = overview.settings?.researchEnabled !== false;
}

function renderUsers() {
    const list = $('users-list');
    list.replaceChildren();
    for (const user of state.users) {
        const row = node('article', null, 'user-row');
        const info = node('div', null, 'user-info');
        info.append(node('h3', user.name || user.email));
        info.append(node('p', user.email, 'row-meta'));
        info.append(node('p', 'Created ' + date(user.createdAt) + ' · Last sign-in ' + date(user.lastLoginAt), 'row-meta'));
        const actions = node('div', null, 'user-actions');
        if (user.disabled) actions.append(node('span', 'Disabled', 'row-meta disabled-label'));
        const view = action('View history', () => {
            $('conversation-owner').value = 'account:' + userId(user);
            $('conversation-query').value = '';
            showSection('conversations');
            loadConversations();
        });
        const toggle = action(user.disabled ? 'Enable account' : 'Disable account', async () => {
            const disabled = !user.disabled;
            if (!window.confirm((disabled ? 'Disable ' : 'Enable ') + user.email + '?')) return;
            toggle.disabled = true;
            try {
                const result = await api('/admin/users/' + encodeURIComponent(userId(user)), {
                    method: 'PATCH', body: JSON.stringify({ disabled })
                });
                if (state.denied) return;
                Object.assign(user, result.user || { disabled });
                renderUsers();
                feedback(disabled ? 'Account disabled and active sessions revoked.' : 'Account enabled.');
            } catch (error) {
                toggle.disabled = false;
                showError(error);
            }
        });
        if (userId(user) === state.ownerId) {
            toggle.disabled = true;
            toggle.title = 'The owner account cannot be disabled.';
        }
        actions.append(view, toggle);
        row.append(info, actions);
        list.append(row);
    }
}

async function loadUsers(append = false) {
    const request = ++state.userRequest;
    const params = new URLSearchParams({ query: $('user-query').value.trim() });
    if (append && state.userNext) params.set('before', state.userNext);
    $('users-status').textContent = 'Loading accounts…';
    $('users-more').disabled = true;
    try {
        const result = await api('/admin/users?' + params);
        if (request !== state.userRequest || state.denied) return;
        state.users = append ? state.users.concat(result.users) : result.users;
        state.userNext = result.next || '';
        renderUsers();
        updateAccountFilter();
        $('users-status').textContent = state.users.length ? state.users.length + ' account(s) shown.' : 'No accounts match this search.';
        $('users-more').hidden = !state.userNext;
    } catch (error) {
        if (request === state.userRequest) showError(error, $('users-status'));
    } finally {
        if (request === state.userRequest) $('users-more').disabled = false;
    }
}

function renderConversations() {
    const list = $('conversations-list');
    list.replaceChildren();
    for (const conversation of state.conversations) {
        const row = action('', () => openConversation(conversation._id), 'conversation-row');
        const content = node('span');
        content.append(node('span', conversation.title || 'Untitled conversation', 'conversation-title'));
        const count = Number.isFinite(conversation.messageCount) ? ' · ' + conversation.messageCount + ' messages' : '';
        content.append(node('span', accountLabel(conversation.owner) + count, 'row-meta'));
        row.append(content, node('span', date(conversation.updatedAt || conversation.createdAt), 'row-date'));
        list.append(row);
    }
}

async function loadConversations(append = false) {
    const request = ++state.conversationRequest;
    const params = new URLSearchParams({
        query: $('conversation-query').value.trim(), owner: $('conversation-owner').value
    });
    if (append && state.conversationNext) params.set('before', state.conversationNext);
    $('conversations-status').textContent = 'Loading conversations…';
    $('conversations-more').disabled = true;
    try {
        const result = await api('/admin/conversations?' + params);
        if (request !== state.conversationRequest || state.denied) return;
        state.conversations = append ? state.conversations.concat(result.conversations) : result.conversations;
        state.conversationNext = result.next || '';
        renderConversations();
        $('conversations-status').textContent = state.conversations.length ?
            state.conversations.length + ' conversation(s) shown.' : 'No conversations match these filters.';
        $('conversations-more').hidden = !state.conversationNext;
    } catch (error) {
        if (request === state.conversationRequest) showError(error, $('conversations-status'));
    } finally {
        if (request === state.conversationRequest) $('conversations-more').disabled = false;
    }
}

function sourceLink(source) {
    try {
        const url = new URL(source.url);
        if (!['https:', 'http:'].includes(url.protocol)) return null;
        const link = node('a', source.title || url.hostname);
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    } catch {
        return null;
    }
}

function renderReport(target, report) {
    if (!report) return;
    const details = node('details');
    details.append(node('summary', 'Research details and sources'));
    if (report.kind) details.append(node('p', 'Research type · ' + report.kind, 'detail-note'));
    const findings = node('ul');
    for (const finding of report.findings || []) {
        const item = node('li', finding.text);
        if (finding.quote) item.append(node('p', 'Supporting excerpt · ' + finding.quote, 'hint'));
        findings.append(item);
    }
    for (const assessment of report.assessments || []) findings.append(node('li', assessment.text));
    for (const listing of report.listings || []) {
        const item = node('li');
        for (const [field, value] of Object.entries(listing.fields || {})) {
            item.append(node('p', field + ' · ' + (value?.text || 'Not stated'), 'detail-note'));
        }
        findings.append(item);
    }
    if (findings.children.length) details.append(findings);
    for (const source of report.sources || []) {
        const entry = node('div', null, 'detail-note');
        const link = sourceLink(source);
        entry.append(link || node('strong', source.title || 'Uploaded document'));
        for (const passage of source.passages || []) {
            entry.append(node('p', (passage.page ? 'Page ' + passage.page + ' · ' : '') + passage.text));
        }
        details.append(entry);
    }
    target.append(details);
}

async function openConversation(id) {
    const request = ++state.detailRequest;
    state.selectedConversation = '';
    $('detail-title').textContent = 'Loading conversation…';
    $('detail-meta').textContent = '';
    $('detail-messages').replaceChildren();
    $('review-note').value = '';
    $('review-feedback').textContent = '';
    $('review-form').hidden = true;
    if (!$('conversation-dialog').open) $('conversation-dialog').showModal();
    try {
        const conversation = await api('/admin/conversations/' + encodeURIComponent(id));
        if (request !== state.detailRequest || state.denied || !$('conversation-dialog').open) return;
        state.selectedConversation = id;
        $('detail-title').textContent = conversation.title || 'Untitled conversation';
        $('detail-meta').textContent = accountLabel(conversation.owner) + ' · Updated ' + date(conversation.updatedAt);
        for (const message of conversation.messages || []) {
            const item = node('article', null, 'detail-message ' + (message.role === 'user' ? 'user' : 'assistant'));
            item.append(node('p', (message.role === 'user' ? 'User' : 'Atlas') + (message.createdAt ? ' · ' + date(message.createdAt) : ''), 'role'));
            if (message.text) item.append(node('p', message.text, 'text'));
            if (message.mode) item.append(node('p', 'Mode · ' + message.mode, 'row-meta'));
            if (message.filters && Object.keys(message.filters).length) {
                item.append(node('p', Object.entries(message.filters).map(([key, value]) => key + ' · ' + value).join('\n'), 'detail-note'));
            }
            if (message.attachment) item.append(node('p', 'Attachment · ' + message.attachment, 'row-meta'));
            renderReport(item, message.report);
            $('detail-messages').append(item);
        }
        if (!$('detail-messages').children.length) $('detail-messages').append(node('p', 'This conversation has no saved messages.', 'hint'));
        $('review-form').hidden = false;
    } catch (error) {
        if (request === state.detailRequest && !ownerOnly(error)) $('detail-title').textContent = error.message;
    }
}

async function loadAudit() {
    $('audit-status').textContent = 'Loading audit log…';
    try {
        const { events } = await api('/admin/audit');
        if (state.denied) return;
        $('audit-list').replaceChildren();
        for (const event of events || []) {
            const item = node('li');
            item.append(node('strong', String(event.action || 'Administrative action').replaceAll('_', ' ')));
            item.append(node('p', date(event.createdAt) + ' · ' + (event.actor || 'Owner') + (event.target ? ' · ' + event.target : '')));
            if (event.note) item.append(node('p', event.note));
            $('audit-list').append(item);
        }
        $('audit-status').textContent = events?.length ? '' : 'No audit events have been recorded yet.';
    } catch (error) {
        showError(error, $('audit-status'));
    }
}

function showSection(name) {
    feedback();
    for (const button of document.querySelectorAll('[data-section]')) {
        if (button.dataset.section === name) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    }
    for (const section of document.querySelectorAll('.admin-section')) section.hidden = section.id !== 'section-' + name;
    if (name === 'audit') loadAudit();
}

async function refresh() {
    if (state.denied) return;
    $('refresh').disabled = true;
    feedback();
    try {
        const profile = await api('/profile');
        state.ownerId = profile.user?.id || profile.user?._id || '';
        await loadOverview();
        if (!state.denied) await loadUsers();
        if (!state.denied) await loadConversations();
    } catch (error) {
        showError(error);
    } finally {
        $('refresh').disabled = false;
    }
}

for (const button of document.querySelectorAll('[data-section]')) {
    button.addEventListener('click', () => showSection(button.dataset.section));
}
$('refresh').addEventListener('click', refresh);
$('user-search').addEventListener('submit', event => { event.preventDefault(); loadUsers(); });
$('conversation-search').addEventListener('submit', event => { event.preventDefault(); loadConversations(); });
$('conversation-owner').addEventListener('change', () => loadConversations());
$('users-more').addEventListener('click', () => loadUsers(true));
$('conversations-more').addEventListener('click', () => loadConversations(true));
$('audit-refresh').addEventListener('click', loadAudit);
$('close-detail').addEventListener('click', () => $('conversation-dialog').close());
$('conversation-dialog').addEventListener('close', () => { state.detailRequest++; state.selectedConversation = ''; });

$('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
        const result = await api('/admin/settings', {
            method: 'PATCH', body: JSON.stringify({
                registrationEnabled: $('registration-enabled').checked,
                researchEnabled: $('research-enabled').checked
            })
        });
        if (state.denied) return;
        $('registration-enabled').checked = result.settings.registrationEnabled;
        $('research-enabled').checked = result.settings.researchEnabled;
        feedback('Service settings saved.');
    } catch (error) {
        showError(error);
    } finally {
        submit.disabled = false;
    }
});

$('review-form').addEventListener('submit', async event => {
    event.preventDefault();
    const id = state.selectedConversation;
    const note = $('review-note').value.trim();
    if (!id || !note) {
        $('review-feedback').textContent = 'Enter a review note first.';
        $('review-note').focus();
        return;
    }
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
        await api('/admin/conversations/' + encodeURIComponent(id) + '/review', {
            method: 'POST', body: JSON.stringify({ note })
        });
        if (state.selectedConversation === id && !state.denied) {
            $('review-note').value = '';
            $('review-feedback').textContent = 'Review recorded in the owner audit log.';
        }
    } catch (error) {
        if (state.selectedConversation === id) showError(error, $('review-feedback'));
    } finally {
        submit.disabled = false;
    }
});

const theme = localStorage.getItem('atlas-theme');
document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme :
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
$('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('atlas-theme', next);
});
refresh();
