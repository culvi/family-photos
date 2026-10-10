/**
 * Who's here: faces of the family members on the site right now, in the header, and on
 * any photo one of them has open. Tap the faces to see who's where, and jump to the photo
 * someone is looking at.
 *
 * Only for people signed in through Cloudflare Access (the server knows who they are);
 * with an access code the site stays anonymous and this does nothing. Check-ins every
 * 20 s while the page is visible, right away when a photo opens or closes.
 */

const Presence = {
    BEAT_MS: 20000,
    me: null,
    others: [],
    _timer: 0,
    _soon: 0,
    el: {},

    async init() {
        try {
            this.me = await API.get('/me');
        } catch {
            return;
        }
        if (!this.me?.presence) return;

        this.el = {
            stack: document.getElementById('presence'),
            button: document.getElementById('presence-button'),
            faces: document.getElementById('presence-faces'),
            popover: document.getElementById('presence-popover'),
            list: document.getElementById('presence-list'),
            usage: document.getElementById('presence-usage'),
            lightboxNote: document.getElementById('lightbox-presence'),
        };
        if (this.me.isAdmin && this.el.usage) this.el.usage.hidden = false;

        this.el.button?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggle();
        });
        document.addEventListener('click', (e) => {
            if (!this.el.popover?.hidden && !this.el.stack.contains(e.target)) this._toggle(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._toggle(false);
        });

        // Opening or closing a photo, or moving between pages: tell the others soon.
        State.subscribe((next, prev) => {
            if (next.lightboxAssetId !== prev.lightboxAssetId) this._beatSoon();
            if (next.assets !== prev.assets) requestAnimationFrame(() => this._markTiles());
        });
        ['map-toggle', 'map-close', 'people-toggle', 'people-close'].forEach((id) =>
            document.getElementById(id)?.addEventListener('click', () => this._beatSoon())
        );
        window.addEventListener('popstate', () => this._beatSoon());

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this._leave();
            else this._beat();
        });
        window.addEventListener('pagehide', () => this._leave());

        this._beat();
    },

    _where() {
        if (State.getProperty('lightboxAssetId')) return 'photo';
        if (window.Places?.isOpen) return 'map';
        if (window.People?.isOpen) return 'people';
        return 'grid';
    },

    _beatSoon() {
        clearTimeout(this._soon);
        this._soon = setTimeout(() => this._beat(), 300);
    },

    async _beat() {
        clearTimeout(this._timer);
        if (document.hidden) return;
        const where = this._where();
        try {
            const response = await API.post('/presence', {
                where,
                assetId: where === 'photo' ? State.getProperty('lightboxAssetId') : null,
            });
            this.others = response.others || [];
            this._render();
        } catch {
            /* offline for a moment: try again next beat */
        }
        this._timer = setTimeout(() => this._beat(), this.BEAT_MS);
    },

    _leave() {
        clearTimeout(this._timer);
        try {
            navigator.sendBeacon?.('/api/presence/leave', new Blob(['{}'], { type: 'application/json' }));
        } catch {
            /* best effort: the server times people out anyway */
        }
    },

    /** Downloads, shares and copies, for the owner's Usage page. */
    logSave(kind) {
        if (!this.me?.presence) return;
        const assetId = Lightbox.currentAsset?.id || null;
        API.post('/usage/event', { kind, assetId }).catch(() => {});
    },

    // ---- Drawing ----

    _face(person, size = 'md') {
        const face = document.createElement('span');
        face.className = `presence-face presence-face-${size}`;
        face.title = person.name;
        if (person.personId) {
            const img = document.createElement('img');
            img.src = API.getPersonThumbnailUrl(person.personId);
            img.alt = '';
            img.decoding = 'async';
            face.appendChild(img);
        } else {
            face.textContent = (person.name || '?').slice(0, 1).toUpperCase();
            face.style.setProperty('--face-hue', String(this._hue(person.name)));
        }
        return face;
    },

    _hue(name = '') {
        let h = 0;
        for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
        return h;
    },

    _describe(person) {
        switch (person.where) {
            case 'photo':
                return 'Looking at a photo';
            case 'map':
                return 'On the map';
            case 'people':
                return 'Browsing people';
            default:
                return 'Browsing photos';
        }
    },

    _render() {
        const { stack, faces, button } = this.el;
        if (!stack) return;
        const others = this.others;
        stack.hidden = others.length === 0 && !this.me.isAdmin;

        const shown = others.slice(0, 3);
        const fragment = document.createDocumentFragment();
        shown.forEach((person) => fragment.appendChild(this._face(person, 'sm')));
        if (others.length > shown.length) {
            const more = document.createElement('span');
            more.className = 'presence-face presence-face-sm presence-more';
            more.textContent = `+${others.length - shown.length}`;
            fragment.appendChild(more);
        }
        if (!others.length && this.me.isAdmin) {
            const empty = document.createElement('span');
            empty.className = 'presence-face presence-face-sm presence-empty';
            empty.textContent = '0';
            fragment.appendChild(empty);
        }
        faces.replaceChildren(fragment);
        const names = others.map((p) => p.name);
        button.setAttribute(
            'aria-label',
            names.length ? `Here now: ${names.join(', ')}` : 'Nobody else is here right now'
        );

        if (!this.el.popover.hidden) this._renderList();
        this._markTiles();
        this._markLightbox();
    },

    _renderList() {
        const list = this.el.list;
        const fragment = document.createDocumentFragment();
        if (!this.others.length) {
            const empty = document.createElement('p');
            empty.className = 'presence-none';
            empty.textContent = 'Nobody else is here right now.';
            fragment.appendChild(empty);
        }
        this.others.forEach((person) => {
            const row = document.createElement('div');
            row.className = 'presence-row';
            row.appendChild(this._face(person, 'md'));
            const text = document.createElement('div');
            text.className = 'presence-row-text';
            const name = document.createElement('strong');
            name.textContent = person.name;
            const what = document.createElement('span');
            what.textContent = this._describe(person);
            text.append(name, what);
            row.appendChild(text);
            if (person.assetId) {
                const look = document.createElement('button');
                look.type = 'button';
                look.className = 'presence-look';
                look.textContent = 'See it';
                look.addEventListener('click', () => {
                    this._toggle(false);
                    Lightbox.open({ id: person.assetId, partial: true }, -1);
                });
                row.appendChild(look);
            }
            fragment.appendChild(row);
        });
        list.replaceChildren(fragment);
    },

    _toggle(open = this.el.popover.hidden) {
        if (!this.el.popover) return;
        this.el.popover.hidden = !open;
        this.el.button.setAttribute('aria-expanded', String(open));
        if (open) this._renderList();
    },

    /** A small face on any photo tile someone else has open. */
    _markTiles() {
        document.querySelectorAll('.presence-badge').forEach((badge) => badge.remove());
        this.others.forEach((person) => {
            if (!person.assetId) return;
            document
                .querySelectorAll(`.gallery-item[data-asset-id="${CSS.escape(person.assetId)}"]`)
                .forEach((tile) => {
                    const badge = this._face(person, 'xs');
                    badge.classList.add('presence-badge');
                    tile.appendChild(badge);
                });
        });
    },

    /** "Nadia is looking at this too" in the lightbox. */
    _markLightbox() {
        const note = this.el.lightboxNote;
        if (!note) return;
        const current = State.getProperty('lightboxAssetId');
        const here = current ? this.others.filter((p) => p.assetId === current) : [];
        if (!here.length) {
            note.hidden = true;
            return;
        }
        const fragment = document.createDocumentFragment();
        here.slice(0, 3).forEach((person) => fragment.appendChild(this._face(person, 'xs')));
        const text = document.createElement('span');
        const names = here.map((p) => p.name);
        text.textContent =
            names.length === 1 ? `${names[0]} is looking too` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are looking too`;
        fragment.appendChild(text);
        note.replaceChildren(fragment);
        note.hidden = false;
    },
};

window.Presence = Presence;
