'use strict';

(() => {
    const sections = [
        ['general', 'General', 'settings'], ['appearance', 'Appearance', 'sun'], ['notifications', 'Notifications', 'bell'],
        ['profile', 'Profile', 'user'], ['security', 'Security and login', 'shield'], ['account', 'Account', 'user'],
        ['archived', 'Archived chats', 'archive'], ['parental', 'Parental controls', 'family'],
        ['safety', 'Safety & wellbeing', 'heart'], ['storage', 'Storage', 'storage'], ['data', 'Data controls', 'sliders']
    ];
    const paths = {
        settings: '<path d="m10 3-1 3-3 1-3 3 2 2-1 3 3 3 3-1 2 2 3-2 1-3 3-1v-4l-3-1-1-3h-3Z"/><circle cx="12" cy="12" r="3"/>',
        bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
        family: '<circle cx="8" cy="7" r="3"/><circle cx="17" cy="8" r="2"/><path d="M2 21v-3a6 6 0 0 1 12 0v3m2-7a4 4 0 0 1 6 4v3"/>',
        heart: '<path d="M20 4c-3-2-6 0-8 3C10 4 7 2 4 4c-5 4 1 11 8 17 7-6 13-13 8-17Z"/>',
        storage: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>',
        help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01"/>',
        chevron: '<path d="m8 10 4 4 4-4"/>'
    };
    let hooks, user = null, data = null, loading = null, generation = 0, currentSection = 'general';
    let trigger, menu, dialog, content, nav, search, status, heading, currentForm = null;

    function el(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined && text !== null) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    function icon(name) {
        if (!paths[name]) return hooks.icon(name);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        svg.classList.add('glyph');
        svg.innerHTML = paths[name];
        return svg;
    }
    function button(text, action, className = 'settings-button', glyph) {
        const control = el('button', null, className);
        control.type = 'button';
        if (glyph) control.append(icon(glyph));
        control.append(document.createTextNode(text));
        if (action) control.addEventListener('click', action);
        return control;
    }
    function avatar(profile, large = false) {
        const node = el('span', null, 'account-avatar' + (large ? ' large' : ''));
        node.setAttribute('aria-hidden', 'true');
        if (/^data:image\/(?:png|jpeg);base64,/.test(profile?.avatarUrl || '')) {
            const image = el('img'); image.src = profile.avatarUrl; image.alt = ''; node.append(image);
        } else node.textContent = (profile?.name || profile?.email || 'A').trim().split(/\s+/).map(part => [...part][0]).slice(0, 2).join('').toLocaleUpperCase();
        return node;
    }
    function date(value) { return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not available'; }
    function showStatus(message = '', error = false) {
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('is-error', error);
    }
    async function request(path, body, method = 'POST') {
        const version = generation;
        const result = await hooks.api(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        if (version !== generation) throw new DOMException('Account changed', 'AbortError');
        return result;
    }
    async function work(control, task) {
        const identity = user?.id;
        const controls = control?.tagName === 'FORM' ? [...control.querySelectorAll('button, input, select')] : control ? [control] : [];
        const previous = controls.map(node => node.disabled);
        controls.forEach(node => { node.disabled = true; });
        showStatus('Saving…');
        try {
            const result = await task();
            if (user?.id !== identity) return;
            return result;
        } catch (error) {
            if (error.name !== 'AbortError' && user?.id === identity) {
                showStatus(error.message, true);
                if (!dialog?.open) hooks.feedback(error.message);
            }
        } finally { controls.forEach((node, i) => { node.disabled = previous[i]; }); }
    }
    async function refresh() {
        if (!user) return null;
        const version = generation;
        const result = await hooks.api('/account');
        if (version !== generation || result.user.id !== user?.id) return null;
        data = result;
        user = result.user;
        updateHeader();
        hooks.preferencesChanged(result.preferences);
        hooks.parentalChanged?.(result.parental);
        return result;
    }
    function updateHeader() {
        if (!trigger) return;
        const name = el('span', user?.name || 'Account'); name.id = 'account-name';
        const photo = avatar(user); photo.id = 'account-photo';
        trigger.replaceChildren(photo, name, icon('chevron'));
        trigger.setAttribute('aria-label', user ? 'Account menu for ' + (user.name || user.email) : 'Account menu');
        const summary = el('div', null, 'account-menu-profile');
        const copy = el('div'); copy.append(el('strong', user?.name || 'Your account'), el('small', user?.email || ''));
        summary.append(avatar(user), copy);
        menu.querySelector('.account-menu-profile')?.replaceWith(summary);
    }
    function hideMenu() { if (menu?.matches(':popover-open')) menu.hidePopover(); }
    function positionMenu() {
        const bounds = trigger.getBoundingClientRect();
        menu.style.top = Math.min(bounds.bottom + 8, window.innerHeight - 320) + 'px';
        menu.style.left = Math.max(8, Math.min(bounds.right - 280, window.innerWidth - 288)) + 'px';
    }
    async function logout() {
        hideMenu();
        await work(null, async () => { await request('/auth/logout', undefined); close(); hooks.signedOut(); });
    }
    function createMenu() {
        menu = el('div', null, 'account-popover'); menu.id = 'atlas-account-menu'; menu.setAttribute('popover', 'auto');
        menu.append(el('div', null, 'account-menu-profile'));
        const items = el('div', null, 'account-menu-items'); items.setAttribute('role', 'menu'); items.setAttribute('aria-label', 'Account');
        for (const [label, section, glyph] of [['Profile', 'profile', 'user'], ['Settings', 'general', 'settings'], ['Help', 'help', 'help']]) {
            const control = button(label, () => open(section), 'account-menu-item', glyph); control.setAttribute('role', 'menuitem'); control.dataset.accountSection = section; items.append(control);
        }
        const signout = button('Sign out', logout, 'account-menu-item account-menu-signout', 'login'); signout.setAttribute('role', 'menuitem'); items.append(signout);
        menu.append(items); document.body.append(menu);
        trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('click', () => { if (menu.matches(':popover-open')) hideMenu(); else { positionMenu(); menu.showPopover(); items.querySelector('button').focus(); } });
        trigger.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); positionMenu(); menu.showPopover(); const rows = [...items.querySelectorAll('button')]; (event.key === 'ArrowDown' ? rows[0] : rows.at(-1)).focus(); } });
        menu.addEventListener('toggle', event => { trigger.setAttribute('aria-expanded', String(event.newState === 'open')); });
        items.addEventListener('keydown', event => {
            const rows = [...items.querySelectorAll('button')], index = rows.indexOf(document.activeElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; rows[next].focus();
            } else if (event.key === 'Escape') { hideMenu(); trigger.focus(); }
        });
        window.addEventListener('resize', () => { if (menu.matches(':popover-open')) positionMenu(); });
    }
    function createDialog() {
        dialog = el('dialog', null, 'account-settings-dialog'); dialog.id = 'atlas-settings-dialog'; dialog.setAttribute('aria-labelledby', 'atlas-settings-title');
        const header = el('header', null, 'account-settings-heading'); heading = el('h2', 'Settings'); heading.id = 'atlas-settings-title';
        const exit = button('', close, 'icon', 'x'); exit.setAttribute('aria-label', 'Close settings'); header.append(heading, exit);
        const layout = el('div', null, 'account-settings-layout');
        const aside = el('aside', null, 'account-settings-nav'); search = el('input', null, 'account-settings-search'); search.type = 'search'; search.placeholder = 'Search settings'; search.setAttribute('aria-label', 'Search settings');
        nav = el('nav', null, 'account-nav-list'); nav.setAttribute('aria-label', 'Settings sections');
        for (const [id, label, glyph] of sections) { const row = button(label, () => renderSection(id), 'account-nav-item', glyph); row.dataset.section = id; nav.append(row); }
        search.addEventListener('input', () => { const query = search.value.trim().toLocaleLowerCase(); for (const row of nav.children) row.hidden = !row.textContent.toLocaleLowerCase().includes(query); });
        aside.append(search, nav);
        const panel = el('div', null, 'account-settings-content'); panel.tabIndex = -1;
        content = el('div', null, 'account-section-body'); status = el('p', null, 'settings-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        panel.append(status, content); layout.append(aside, panel); dialog.append(header, layout); document.body.append(dialog);
        dialog.addEventListener('close', () => { content.replaceChildren(); currentForm = null; trigger.focus(); });
        dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } });
    }
    function title(label, description) { content.append(el('h3', label, 'account-section-title'), el('p', description, 'account-section-description')); }
    function field(form, label, name, type = 'text', options = {}) {
        const wrapper = el('label', null, 'settings-field'); wrapper.append(el('span', label)); const input = el('input'); input.name = name; input.type = type;
        for (const [key, value] of Object.entries(options)) input[key] = value;
        wrapper.append(input); form.append(wrapper); return input;
    }
    function row(label, description, control) { const line = el('div', null, 'settings-row'), copy = el('div', null, 'settings-row-copy'); copy.append(el('strong', label), el('small', description)); line.append(copy, control); content.append(line); }
    function form(label) { const node = el('form', null, 'settings-form'); node.setAttribute('aria-label', label); currentForm = node; return node; }
    function submit(node, text, glyph = 'check', className = 'primary settings-button') { const save = button(text, null, className, glyph); save.type = 'submit'; node.append(save); return save; }
    async function savePreference(key, value, control) {
        const version = generation, identity = user?.id;
        const before = data.preferences[key];
        await work(control, async () => {
            const result = await request('/account/preferences', { [key]: value }, 'PATCH');
            if (version !== generation || identity !== user?.id || !data) return;
            data.preferences = result.preferences; hooks.preferencesChanged(result.preferences); showStatus('Saved.');
        });
        if (version !== generation || identity !== user?.id || !data) return;
        if (control.type === 'checkbox') control.checked = data.preferences[key] ?? before; else control.value = String(data.preferences[key] ?? before);
    }
    function preference(label, description, key, choices) {
        let control;
        if (choices) { control = el('select', null, 'settings-select'); for (const [value, text] of choices) { const option = el('option', text); option.value = value; control.append(option); } control.value = data.preferences[key]; }
        else { control = el('input', null, 'settings-toggle'); control.type = 'checkbox'; control.checked = data.preferences[key]; }
        control.name = key; control.setAttribute('aria-label', label);
        control.addEventListener('change', () => savePreference(key, choices ? (key === 'breakReminderMinutes' ? Number(control.value) : control.value) : control.checked, control));
        row(label, description, control);
    }
    function general() {
        title('General', 'Choose how your conversations work. Changes are saved to your account.');
        preference('Default research depth', 'The starting choice for each new chat.', 'defaultDepth', [['quick', 'Quick'], ['detailed', 'Detailed']]);
        preference('Enter to send', 'Press Shift + Enter for a new line when enabled.', 'enterToSend');
        preference('Follow new replies', 'Automatically scroll as a reply finishes.', 'autoScroll');
    }
    function appearance() {
        title('Appearance', 'Make Atlas comfortable for you.');
        preference('Theme', 'Follow your device or choose a light or dark appearance.', 'theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]);
        preference('Text size', 'Adjust the size of conversation text.', 'textSize', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]);
        preference('Animated background', 'Show the gentle background glow and moving details.', 'backgroundMotion');
        preference('Reduce motion', 'Keep transitions and movement to a minimum.', 'reducedMotion');
    }
    function notifications() {
        title('Notifications', 'Choose when Atlas lets you know that a reply is ready.');
        preference('Reply notifications', 'Show an in-app notice and a browser notification when Atlas is in the background.', 'replyNotifications');
        preference('Show reply preview', 'Include the beginning of your reply in browser notifications.', 'notificationPreview');
        const supported = 'Notification' in window && window.isSecureContext;
        const permission = supported ? Notification.permission : 'unavailable';
        const enable = button(permission === 'granted' ? 'Permission granted' : permission === 'denied' ? 'Blocked in browser settings' : permission === 'unavailable' ? 'Unavailable in this browser' : 'Allow notifications', async () => {
            const granted = await Notification.requestPermission();
            showStatus(granted === 'granted' ? 'Browser notifications are enabled.' : 'Browser notifications were not enabled.'); renderSection('notifications', false);
        });
        enable.disabled = permission !== 'default'; row('Browser permission', 'Your browser asks before allowing notifications. Change blocked permissions in its site settings.', enable);
        if (permission === 'granted') row('Try a notification', 'Preview a notification without sharing conversation text.', button('Send test', () => {
            try { new Notification('Atlas notifications are ready', { body: 'Your browser can notify you when a reply is ready.', icon: '/atlas-mark.svg' }); showStatus('Test notification sent.'); }
            catch { showStatus('Your browser could not display the notification.', true); }
        }, 'settings-button', 'bell'));
    }
    async function photoData(file) {
        if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG or JPEG photo under 10 MB.');
        const image = await createImageBitmap(file);
        try {
            if (image.width * image.height > 30_000_000) throw new Error('Choose a photo smaller than 30 megapixels.');
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
            const context = canvas.getContext('2d'); context.fillStyle = '#f1efe7'; context.fillRect(0, 0, 256, 256);
            const side = Math.min(image.width, image.height);
            context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 256, 256);
            return canvas.toDataURL('image/jpeg', .86);
        } finally { image.close(); }
    }
    function profile() {
        title('Profile', 'Your name and photo appear in your Atlas account.');
        const banner = el('div', null, 'settings-profile-banner'), preview = el('div'); preview.append(avatar(user, true));
        const copy = el('div'); copy.append(el('strong', user.name || 'Your profile'), el('p', user.email)); banner.append(preview, copy); content.append(banner);
        const editor = form('Update profile'); let pendingAvatar;
        const photo = el('input'); photo.type = 'file'; photo.accept = 'image/png,image/jpeg'; photo.hidden = true; photo.setAttribute('aria-label', 'Choose profile photo');
        const actions = el('div', null, 'settings-photo-actions');
        const choose = button('Change photo', () => photo.click(), 'settings-button', 'user');
        const remove = button('Remove photo', () => { pendingAvatar = null; photo.value = ''; preview.replaceChildren(avatar({ ...user, avatarUrl: '' }, true)); showStatus('Save your profile to remove the photo.'); }, 'settings-button', 'trash');
        actions.append(choose, remove, photo); editor.append(actions);
        photo.addEventListener('change', async () => {
            const file = photo.files[0]; if (!file) return;
            const version = generation;
            const save = editor.querySelector('[type="submit"]');
            choose.disabled = true; if (save) save.disabled = true; showStatus('Preparing photo…');
            try {
                const result = await photoData(file); if (version !== generation || !editor.isConnected) return;
                pendingAvatar = result; preview.replaceChildren(avatar({ ...user, avatarUrl: result }, true)); showStatus('Photo ready. Save your profile to apply it.');
            } catch (error) { showStatus(error.message || 'That photo could not be read. Choose a PNG or JPEG.', true); }
            finally { choose.disabled = false; if (save) save.disabled = false; }
        });
        field(editor, 'Display name', 'name', 'text', { value: user.name || '', required: true, maxLength: 80, autoComplete: 'name' });
        field(editor, 'Email address', 'email', 'email', { value: user.email, readOnly: true, autoComplete: 'email' });
        submit(editor, 'Save profile');
        editor.addEventListener('submit', event => {
            event.preventDefault(); if (!editor.reportValidity()) return;
            const values = new FormData(editor), patch = { name: String(values.get('name')).trim() };
            if (pendingAvatar !== undefined) patch.avatarData = pendingAvatar;
            work(editor, async () => {
                const identity = user.id; const result = await request('/account/profile', patch, 'PATCH'); if (identity !== user?.id) return;
                user = result.user; data.user = user; hooks.profileChanged(user); updateHeader(); pendingAvatar = undefined;
                copy.querySelector('strong').textContent = user.name || 'Your profile';
                preview.replaceChildren(avatar(user, true));
                showStatus('Your profile has been updated.');
            });
        });
        content.append(editor);
    }
    function passwordField(node, label = 'Current password', name = 'currentPassword', required = true) {
        return field(node, label, name, 'password', { required, maxLength: 128, autoComplete: name === 'newPassword' ? 'new-password' : 'current-password' });
    }
    function security() {
        title('Security and login', 'Manage how you sign in and close sessions you no longer use.');
        if (user.hasPassword) {
            const change = form('Change password'); change.append(el('h4', 'Change password'));
            passwordField(change); const next = passwordField(change, 'New password', 'newPassword'); next.minLength = 12;
            const confirm = passwordField(change, 'Confirm new password', 'confirmPassword'); confirm.minLength = 12;
            submit(change, 'Update password', 'shield');
            change.addEventListener('submit', event => {
                event.preventDefault(); if (!change.reportValidity()) return;
                const values = Object.fromEntries(new FormData(change));
                if (values.newPassword !== values.confirmPassword) { showStatus('The new passwords do not match.', true); return; }
                work(change, async () => { await request('/auth/password', { currentPassword: values.currentPassword, newPassword: values.newPassword }); await refresh(); renderSection('security'); showStatus('Password updated. Other sessions have been signed out.'); });
            }); content.append(change, el('hr', null, 'settings-divider'));
        }
        const linking = form('Connect a sign-in method'); linking.append(el('h4', 'Connected sign-in methods'));
        if (user.hasPassword) passwordField(linking, 'Confirm password to connect a provider');
        else linking.append(el('p', 'Sign in again if your session is more than five minutes old before connecting another provider.', 'account-section-description'));
        const providers = el('div', null, 'settings-security-providers'); linking.append(providers); linking.addEventListener('submit', event => event.preventDefault()); content.append(linking);
        function providerButtons(list) {
            if (!providers.isConnected) return;
            providers.replaceChildren();
            for (const provider of list.filter(item => ['google', 'github', 'microsoft'].includes(item.id))) {
                const connected = user.providers?.includes(provider.id);
                const control = button(provider.name + (connected ? ' · Connected' : ''), () => {
                    if (!linking.reportValidity()) return;
                    const body = { link: true, acceptTerms: true };
                    if (user.hasPassword) body.currentPassword = new FormData(linking).get('currentPassword');
                    work(linking, async () => { const result = await request('/auth/oauth/' + provider.id + '/start', body); const url = new URL(result.url); if (url.protocol !== 'https:') throw new Error('Invalid sign-in provider address.'); showStatus('Opening ' + provider.name + '…'); location.assign(url.href); });
                }, 'settings-button settings-provider-button');
                control.prepend(hooks.providerIcon(provider.id)); control.disabled = connected || !provider.enabled;
                if (!provider.enabled) control.title = 'This sign-in provider has not been configured yet.';
                providers.append(control);
            }
            if (list.every(item => !item.enabled)) providers.append(el('small', 'Social sign-in is not configured yet.'));
        }
        providerButtons(hooks.getProviders());
        hooks.api('/auth/providers').then(result => providerButtons(result.providers)).catch(() => {});
        content.append(el('hr', null, 'settings-divider'), el('h4', 'Active sessions'));
        const sessions = el('div', null, 'settings-session-list');
        for (const session of data.sessions) {
            const line = el('div', null, 'settings-list-row'), copy = el('div', null, 'settings-list-copy');
            copy.append(el('strong', session.current ? 'This session' : 'Another signed-in session'), el('small', 'Signed in ' + date(session.createdAt)), el('small', 'Expires ' + date(session.expiresAt)));
            line.append(copy);
            if (session.current) line.append(el('span', 'Current', 'settings-badge'));
            else { const revoke = button('Sign out', () => work(revoke, async () => { await request('/account/sessions/' + session.id, undefined, 'DELETE'); await refresh(); renderSection('security'); showStatus('Session signed out.'); }), 'settings-button', 'login'); line.append(revoke); }
            sessions.append(line);
        }
        content.append(sessions);
        const others = form('Sign out other sessions'); others.append(el('h4', 'Sign out everywhere else'));
        if (user.hasPassword) passwordField(others);
        else others.append(el('p', 'For this action, sign in again if your session is more than five minutes old.', 'account-section-description'));
        submit(others, 'Sign out other sessions', 'shield');
        others.addEventListener('submit', event => { event.preventDefault(); if (!others.reportValidity()) return; const payload = Object.fromEntries(new FormData(others)); work(others, async () => { await request('/account/sessions/revoke-others', payload); await refresh(); renderSection('security'); showStatus('Other sessions have been signed out.'); }); }); content.append(others);
    }
    function account() {
        title('Account', 'Your Atlas account details and access.');
        row('Email address', user.email, el('span', user.hasPassword ? 'Email and password' : 'Social sign-in', 'settings-badge'));
        row('Created', date(user.createdAt), el('span', user.isAdmin ? 'Owner' : 'Member', 'settings-badge'));
        row('Sign out', 'Close this session on your current device.', button('Sign out', logout, 'settings-button', 'login'));
        content.append(el('hr', null, 'settings-divider'));
        if (user.isAdmin) { content.append(el('h4', 'Owner account'), el('p', 'Your owner account is retained so you can administer Atlas.', 'account-section-description')); return; }
        const deletion = form('Delete account'); deletion.append(el('h4', 'Delete account'), el('p', 'This permanently removes your profile and saved conversations. Download your data first if you want a copy.', 'account-section-description'));
        const confirmation = field(deletion, 'Type DELETE to confirm', 'confirmation', 'text', { required: true, pattern: 'DELETE', autoComplete: 'off' });
        if (user.hasPassword) passwordField(deletion); else deletion.append(el('p', 'A sign-in within the last five minutes is required.', 'account-section-description'));
        submit(deletion, 'Delete my account', 'trash', 'settings-button danger');
        deletion.addEventListener('submit', event => { event.preventDefault(); if (!deletion.reportValidity()) return; const payload = Object.fromEntries(new FormData(deletion)); work(deletion, async () => { await request('/account', payload, 'DELETE'); confirmation.value = ''; close(); hooks.signedOut(); hooks.feedback('Your Atlas account has been deleted.'); }); }); content.append(deletion);
    }
    async function archived() {
        title('Archived chats', 'Archived conversations stay saved until you restore or delete them.');
        const list = el('div', 'Loading archived chats…', 'settings-session-list'); content.append(list);
        try {
            const chats = await hooks.api('/conversations?archived=true'); if (!list.isConnected) return;
            list.replaceChildren();
            if (!chats.length) { list.append(el('p', 'No archived conversations yet.', 'account-section-description')); return; }
            for (const chat of chats) {
                const line = el('div', null, 'settings-list-row'), copy = el('div', null, 'settings-list-copy'); copy.append(el('strong', chat.title), el('small', date(chat.updatedAt)));
                const actions = el('div', null, 'settings-actions');
                const openChat = button('Open', () => { close(); hooks.openConversation(chat.id); }, 'settings-button', 'chat');
                const restore = button('Restore', () => work(restore, async () => { await request('/conversations/' + chat.id, { archived: false }, 'PATCH'); await hooks.historyChanged(); await refresh(); renderSection('archived'); showStatus('Conversation restored to your history.'); }), 'settings-button', 'refresh');
                const remove = button('Delete', () => {
                    const confirmation = el('form', null, 'settings-form settings-inline-confirm');
                    field(confirmation, 'Type DELETE to delete this chat', 'confirmation', 'text', { required: true, pattern: 'DELETE', autoComplete: 'off' });
                    submit(confirmation, 'Delete chat', 'trash', 'settings-button danger');
                    confirmation.append(button('Cancel', () => { confirmation.remove(); remove.disabled = false; remove.focus(); }));
                    confirmation.addEventListener('submit', event => { event.preventDefault(); if (!confirmation.reportValidity()) return; work(confirmation, async () => { await request('/conversations/' + chat.id, undefined, 'DELETE'); await hooks.historyChanged(); await refresh(); renderSection('archived'); showStatus('Archived conversation deleted.'); }); });
                    line.append(confirmation); remove.disabled = true; confirmation.querySelector('input').focus();
                }, 'settings-button danger', 'trash');
                actions.append(openChat, restore, remove); line.append(copy, actions); list.append(line);
            }
        } catch (error) { if (list.isConnected && error.name !== 'AbortError') { list.textContent = error.message; showStatus(error.message, true); } }
    }
    function parental() {
        const controls = data.parental;
        title('Parental controls', 'Protect the browsing and safety controls on this account with a six-digit PIN.');
        const editor = form('Update parental controls');
        const enabledLabel = el('label', null, 'settings-row'), enabled = el('input', null, 'settings-toggle'); enabled.type = 'checkbox'; enabled.name = 'enabled'; enabled.checked = controls.enabled;
        enabledLabel.append(el('strong', 'Enable PIN protection'), enabled); editor.append(enabledLabel);
        if (controls.enabled) field(editor, 'Current six-digit PIN', 'currentPin', 'password', { required: true, pattern: '[0-9]{6}', minLength: 6, maxLength: 6, inputMode: 'numeric', autoComplete: 'off' });
        else {
            field(editor, 'Choose a six-digit PIN', 'pin', 'password', { pattern: '[0-9]{6}', minLength: 6, maxLength: 6, inputMode: 'numeric', autoComplete: 'off' });
            if (user.hasPassword) passwordField(editor, 'Confirm account password', 'currentPassword', false);
            else editor.append(el('p', 'To enable PIN protection, use a sign-in from the last five minutes.', 'account-section-description'));
        }
        const options = el('fieldset', null, 'settings-parental-options'); options.append(el('legend', 'Protected controls'));
        for (const [key, label, description] of [['webResearch', 'Allow web research', 'Allow fresh searches for research, jobs, and products.'], ['pdfUploads', 'Allow PDF uploads', 'Allow new documents to be uploaded for analysis.'], ['contentFilter', 'Filter explicit-content requests', 'Block recognized explicit sexual or graphic-content requests. This filter can miss some content.']]) {
            const labelNode = el('label', null, 'settings-row'), copy = el('span', null, 'settings-row-copy'); copy.append(el('strong', label), el('small', description));
            const checkbox = el('input', null, 'settings-toggle'); checkbox.type = 'checkbox'; checkbox.name = key; checkbox.checked = controls[key]; checkbox.disabled = !enabled.checked; labelNode.append(copy, checkbox); options.append(labelNode);
        }
        editor.append(options);
        let newPin;
        if (controls.enabled) newPin = field(editor, 'New PIN (optional)', 'newPin', 'password', { pattern: '[0-9]{6}', minLength: 6, maxLength: 6, inputMode: 'numeric', autoComplete: 'off' });
        function updateControls() {
            for (const checkbox of options.querySelectorAll('input')) checkbox.disabled = !enabled.checked;
            const pin = editor.querySelector('[name="pin"]'); if (pin) pin.required = enabled.checked;
            const password = editor.querySelector('[name="currentPassword"]'); if (password) password.required = enabled.checked;
            if (newPin) newPin.disabled = !enabled.checked;
        }
        enabled.addEventListener('change', updateControls); updateControls();
        submit(editor, 'Save parental controls', 'shield');
        editor.addEventListener('submit', event => {
            event.preventDefault(); if (!editor.reportValidity()) return;
            const values = Object.fromEntries(new FormData(editor)), body = { enabled: enabled.checked };
            const version = generation, identity = user?.id;
            if (enabled.checked) for (const key of ['webResearch', 'pdfUploads', 'contentFilter']) body[key] = values[key] === 'on';
            for (const key of ['pin', 'currentPin', 'newPin', 'currentPassword']) if (values[key]) body[key] = values[key];
            work(editor, async () => {
                const result = await request('/account/parental', body);
                if (version !== generation || identity !== user?.id || !data) return;
                data.parental = result.parental; hooks.parentalChanged?.(result.parental); renderSection('parental'); showStatus('Parental controls saved.');
            });
        }); content.append(editor);
    }
    function safety() {
        title('Safety & wellbeing', 'Set a gentle reminder and check your account’s browsing controls.');
        preference('Break reminder', 'A reminder after active use in this tab. It does not interrupt or close your conversation.', 'breakReminderMinutes', [[0, 'Off'], [15, '15 minutes'], [30, '30 minutes'], [60, '60 minutes']]);
        const controls = data.parental;
        const summary = controls.enabled ? 'PIN protection is on. Web research: ' + (controls.webResearch ? 'allowed' : 'blocked') + '. PDF uploads: ' + (controls.pdfUploads ? 'allowed' : 'blocked') + '. Explicit-content filter: ' + (controls.contentFilter ? 'on' : 'off') + '.' : 'PIN protection is off. You can protect research, PDF uploads, and the explicit-content filter with a parental PIN.';
        row('Browsing and content controls', summary, button('Manage controls', () => renderSection('parental'), 'settings-button', 'shield'));
    }
    function deleteChats() {
        const details = el('details', null, 'settings-card'); details.append(el('summary', 'Delete all saved chats'));
        const deletion = form('Delete all saved chats'); deletion.append(el('p', 'This permanently removes your active and archived conversations. Download a copy first if you want to keep them.', 'account-section-description'));
        field(deletion, 'Type DELETE to confirm', 'confirmation', 'text', { required: true, pattern: 'DELETE', autoComplete: 'off' }); submit(deletion, 'Delete all chats', 'trash', 'settings-button danger');
        deletion.addEventListener('submit', event => {
            event.preventDefault(); if (!deletion.reportValidity()) return;
            work(deletion, async () => { const result = await request('/account/delete-chats', { confirmation: 'DELETE' }); await hooks.historyChanged({ deletedAll: true }); await refresh(); renderSection(currentSection); showStatus(result.deleted + ' saved conversation' + (result.deleted === 1 ? '' : 's') + ' deleted.'); });
        }); details.append(deletion); return details;
    }
    function exportButton() {
        const control = button('Download my data', () => work(control, async () => {
            const result = await request('/account/export', undefined, 'GET'); const file = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(file);
            const anchor = el('a'); anchor.href = url; anchor.download = 'atlas-account-' + new Date().toISOString().slice(0, 10) + '.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); showStatus('Your account export has been downloaded.');
        }), 'settings-button', 'download'); return control;
    }
    function storage() {
        title('Storage', 'Review the saved conversation data in your account.');
        const grid = el('div', null, 'settings-stat-grid'), stats = data.storage;
        for (const [label, value] of [['Saved chats', stats.conversationCount], ['Archived chats', stats.archivedCount], ['Messages', stats.messageCount]]) { const card = el('div', null, 'settings-stat'); card.append(el('strong', Number(value || 0).toLocaleString()), el('small', label)); grid.append(card); }
        content.append(grid);
        const bytes = Number(stats.bytes || 0); const size = bytes < 1024 ? bytes + ' bytes' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
        const reload = button('Refresh storage', () => work(reload, async () => { await refresh(); renderSection('storage'); showStatus('Storage totals updated.'); }), 'settings-button', 'refresh');
        row('Saved conversation size', size + '. Original uploaded PDF files are processed in memory; saved answers may include excerpts.', reload);
        row('Archived conversations', 'Restore or remove conversations you have put away.', button('Manage archived chats', () => renderSection('archived'), 'settings-button', 'archive'));
        row('Keep a copy', 'Export your profile, preferences, and saved conversations as JSON.', exportButton()); content.append(deleteChats());
    }
    function dataControls() {
        title('Data controls', 'Manage your saved conversations and download a copy of your account data.');
        preference('Confirm before deleting a chat', 'Ask for confirmation before deleting the currently open chat.', 'confirmBeforeDelete');
        row('Export account data', 'Download your profile, preferences, and active and archived conversations.', exportButton());
        content.append(deleteChats());
        const terms = el('a', 'Terms and Conditions'); terms.href = '/atlas/terms'; terms.target = '_blank'; terms.rel = 'noopener noreferrer'; content.append(terms);
    }
    function help() {
        title('Help with Atlas', 'A few ways to get more from your conversations.');
        const grid = el('div', null, 'settings-help-grid');
        for (const [label, description, glyph] of [
            ['Start a conversation', 'Ask a question, draft something, or explain an idea. You can chat without choosing a tool.', 'chat'],
            ['Find jobs', 'Use Jobs beside the composer or ask naturally, such as “Find remote developer jobs.” Add a role and location when they matter.', 'briefcase'],
            ['Compare products', 'Choose Marketplace or ask about a product. Include your delivery country, budget, and exact requirements for useful comparisons.', 'shopping'],
            ['Ask about a PDF', 'Attach a PDF under 5 MB, then ask about it. Saved document evidence includes page references when available.', 'paperclip'],
            ['Check the evidence', 'Open a numbered citation to inspect its supporting passage. Compare up to three listed jobs or products.', 'file'],
            ['Keep your conversations', 'Your signed-in chats are saved in history. Use conversation actions to archive, export, print, or delete a chat.', 'archive']
        ]) { const card = el('article', null, 'settings-card'); const labelNode = el('h4', label); labelNode.prepend(icon(glyph)); card.append(labelNode, el('p', description)); grid.append(card); }
        content.append(grid);
        const terms = el('a', 'Read the Terms and Conditions'); terms.href = '/atlas/terms'; terms.target = '_blank'; terms.rel = 'noopener noreferrer'; content.append(terms);
    }
    const renderers = { general, appearance, notifications, profile, security, account, archived, parental, safety, storage, data: dataControls, help };
    function renderSection(section, clear = true) {
        currentSection = Object.hasOwn(renderers, section) ? section : 'general';
        if (!data && section !== 'help') return;
        currentForm = null; content.replaceChildren(); if (clear) showStatus();
        heading.textContent = currentSection === 'profile' ? 'Your profile' : currentSection === 'help' ? 'Help' : 'Settings';
        for (const row of nav.children) { if (row.dataset.section === currentSection) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current'); }
        dialog.querySelector('.account-settings-content').scrollTop = 0;
        renderers[currentSection]();
    }
    async function open(section = 'profile') {
        if (!hooks || !user) return;
        hideMenu(); currentSection = section; search.value = ''; for (const row of nav.children) row.hidden = false;
        if (!dialog.open) dialog.showModal();
        if (section === 'help') { renderSection('help'); return; }
        content.replaceChildren(el('p', 'Loading account settings…', 'account-section-description')); showStatus();
        const version = generation;
        try {
            const result = await (loading || refresh());
            if (version !== generation || !dialog.open || !user) return;
            if (result) renderSection(currentSection);
        } catch (error) { if (version === generation && error.name !== 'AbortError') { content.replaceChildren(el('p', 'Account settings could not be loaded.', 'account-section-description')); showStatus(error.message, true); } }
    }
    function close() { hideMenu(); if (dialog?.open) dialog.close(); }
    function updateUser(next) {
        if (!hooks) return;
        const changed = next?.id !== user?.id;
        user = next;
        if (changed) {
            generation++; data = null; loading = null; close(); showStatus();
            if (user) {
                const version = generation;
                const task = refresh().catch(error => { if (version === generation && error.name !== 'AbortError') hooks.feedback('Account settings could not be loaded. Open Settings to try again.'); return null; });
                loading = task; task.finally(() => { if (loading === task) loading = null; });
            }
        } else if (data && user) data.user = user;
        updateHeader();
    }
    function init(options) {
        if (hooks) return; hooks = options; trigger = document.getElementById('account'); createMenu(); createDialog(); updateHeader();
    }
    window.AtlasAccount = { init, updateUser, open, close, getPreferences: () => data?.preferences ? { ...data.preferences } : null };
})();
