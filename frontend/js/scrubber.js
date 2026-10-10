/**
 * Timeline scrubber: a rail of years on the right edge. Drag (or tap, or use the arrow
 * keys) to pick a month; the gallery then starts at that month, and scrolling either way
 * carries on: older photos page in below, newer ones above.
 *
 * Photos load page by page, so this jumps rather than mirroring scroll: the rail is laid
 * out from Immich's per-month counts (sqrt-weighted, so busy years get more room without
 * squeezing quiet ones out of reach), and the indicator tracks the month on screen.
 *
 * Shown only when the gallery is in date order: no text search (relevance order) and no
 * filters other than a single person (the counts can follow one person, nothing else).
 */

const Scrubber = {
    el: {
        rail: null,
        labels: null,
        indicator: null,
        bubble: null,
    },

    buckets: [], // [{month, count}], newest first
    _bucketsKey: null, // which view `buckets` belongs to
    layout: [], // [{month, top, height}] as fractions of the rail
    _key: null, // which buckets are loaded: 'all', a person id, or null (hidden)
    _dragging: false,
    _previewIndex: -1,
    _scrollFrame: 0,
    _idleTimer: 0,

    init() {
        this.el.rail = document.getElementById('scrubber');
        if (!this.el.rail) return;
        this.el.labels = document.getElementById('scrubber-labels');
        this.el.indicator = document.getElementById('scrubber-indicator');
        this.el.bubble = document.getElementById('scrubber-bubble');

        const rail = this.el.rail;
        rail.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        rail.addEventListener('pointermove', (e) => {
            if (this._dragging) this._previewAt(e.clientY);
        });
        rail.addEventListener('pointerup', () => this._finishDrag(true));
        rail.addEventListener('pointercancel', () => this._finishDrag(false));
        rail.addEventListener('keydown', (e) => this._onKeyDown(e));
        rail.addEventListener('blur', () => this._hideBubble());

        window.addEventListener(
            'scroll',
            () => {
                this._scheduleIndicator();
                this._wake();
            },
            { passive: true }
        );
        window.addEventListener('resize', () => {
            if (!rail.hidden) this._renderLabels();
            this._placeRail();
        });

        State.subscribe((newState, oldState) => this.onStateChange(newState, oldState));
        this.refresh();
    },

    eligibleKey(state) {
        const filtered =
            state.query ||
            state.dateFrom ||
            state.dateTo ||
            state.mediaType !== 'ALL' ||
            state.cameraMake ||
            state.cameraModel ||
            state.country ||
            state.city ||
            state.personIds.length > 1;
        if (filtered) return null;
        return state.personIds[0] || 'all';
    },

    onStateChange(newState, oldState) {
        // Any change to what's being viewed starts fresh from the newest photos.
        if (newState.jumpTo && this.eligibleKey(newState) !== this.eligibleKey(oldState)) {
            State.set({ jumpTo: null, newerPage: 0, hasNewer: false });
            return;
        }
        if (this.eligibleKey(newState) !== this._key) this.refresh();
        if (newState.assets !== oldState.assets) this._scheduleIndicator();
    },

    async refresh() {
        const key = this.eligibleKey(State.get());
        this._key = key;
        if (!key) {
            this.hide();
            Gallery.updateResultCount(State.get());
            return;
        }

        let buckets = [];
        try {
            const response = await API.getTimelineBuckets(key === 'all' ? null : key);
            buckets = response.buckets || [];
        } catch (error) {
            console.error('Failed to load timeline:', error);
        }
        if (this._key !== key) return; // a newer refresh won

        this.buckets = buckets;
        this._bucketsKey = key;
        Gallery.updateResultCount(State.get());
        if (buckets.length < 2) {
            this.hide(); // a single month has nothing to scrub
            return;
        }
        this._computeLayout();
        this.show();
    },

    /** Photos in the current view per Immich's counts, or null when they don't apply. */
    totalFor(state) {
        const key = this.eligibleKey(state);
        if (!key || key !== this._bucketsKey) return null;
        return this.buckets.reduce((sum, b) => sum + b.count, 0);
    },

    show() {
        this.el.rail.hidden = false;
        document.body.classList.add('has-scrubber');
        this.el.rail.setAttribute('aria-valuemin', '0');
        this.el.rail.setAttribute('aria-valuemax', String(this.buckets.length - 1));
        this._placeRail();
        this._renderLabels();
        this._updateIndicator();
    },

    hide() {
        if (!this.el.rail) return;
        this.el.rail.hidden = true;
        document.body.classList.remove('has-scrubber');
        this._hideBubble();
    },

    _computeLayout() {
        const weights = this.buckets.map((b) => Math.sqrt(b.count));
        const total = weights.reduce((sum, w) => sum + w, 0) || 1;
        let top = 0;
        this.layout = this.buckets.map((bucket, i) => {
            const height = weights[i] / total;
            const entry = { month: bucket.month, top, height };
            top += height;
            return entry;
        });
    },

    /** Start the rail just below the header (its height differs between phone and desktop). */
    _placeRail() {
        const header = document.querySelector('.header');
        // offsetHeight, not the on-screen position: the header slides away while scrolling.
        const bottom = header ? header.offsetHeight : 0;
        this.el.rail.style.setProperty('--scrubber-top', `${Math.round(bottom + 8)}px`);
    },

    /** One label per year at its newest month, skipping any that would collide. */
    _renderLabels() {
        const height = this.el.rail.clientHeight || 1;
        const minGap = 18;
        const fragment = document.createDocumentFragment();
        let lastYear = null;
        let lastY = -Infinity;

        this.layout.forEach((entry) => {
            const year = entry.month.slice(0, 4);
            if (year === lastYear) return;
            lastYear = year;
            const y = entry.top * height;
            if (y - lastY < minGap) return;
            lastY = y;

            const label = document.createElement('span');
            label.textContent = this.shortYear(year);
            label.style.top = `${(entry.top * 100).toFixed(3)}%`;
            fragment.appendChild(label);
        });

        this.el.labels.replaceChildren(fragment);
    },

    _indexAtFraction(fraction) {
        const f = Math.min(Math.max(fraction, 0), 0.999999);
        for (let i = 0; i < this.layout.length; i += 1) {
            const entry = this.layout[i];
            if (f < entry.top + entry.height) return i;
        }
        return this.layout.length - 1;
    },

    _onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        this._dragging = true;
        // Capture on the element actually pressed: on touch that's the handle, since the
        // rail itself ignores pointers there. Events still bubble to the rail's listeners.
        try {
            e.target.setPointerCapture?.(e.pointerId);
        } catch {
            /* capture is a nicety; dragging still works within the rail */
        }
        this.el.rail.classList.add('dragging');
        this._previewAt(e.clientY);
    },

    _finishDrag(commit) {
        if (!this._dragging) return;
        this._dragging = false;
        this.el.rail.classList.remove('dragging');
        this._wake();
        const index = this._previewIndex;
        this._hideBubble();
        if (commit && index >= 0) this.jumpTo(this.layout[index].month);
    },

    _previewAt(clientY) {
        const rect = this.el.rail.getBoundingClientRect();
        const fraction = (clientY - rect.top) / (rect.height || 1);
        this._preview(this._indexAtFraction(fraction));
    },

    _preview(index) {
        this._previewIndex = index;
        const entry = this.layout[index];
        if (!entry) return;
        const label = this.monthLabel(entry.month);
        const top = this._placeAt(entry);
        this.el.bubble.textContent = label;
        this.el.bubble.style.top = top;
        this.el.indicator.style.top = top; // the handle follows the finger
        this.el.bubble.hidden = false;
        this.el.rail.setAttribute('aria-valuenow', String(index));
        this.el.rail.setAttribute('aria-valuetext', label);
    },

    _hideBubble() {
        const wasPreviewing = this._previewIndex >= 0;
        this._previewIndex = -1;
        if (this.el.bubble) this.el.bubble.hidden = true;
        if (wasPreviewing) this._updateIndicator(); // snap back to what's on screen
    },

    _onKeyDown(e) {
        const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 12, PageUp: -12 };
        if (e.key in steps || e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            const last = this.layout.length - 1;
            let index = this._previewIndex >= 0 ? this._previewIndex : this._currentIndex();
            if (e.key === 'Home') index = 0;
            else if (e.key === 'End') index = last;
            else index = Math.min(Math.max(index + steps[e.key], 0), last);
            this._preview(index);
        } else if (e.key === 'Enter' && this._previewIndex >= 0) {
            e.preventDefault();
            const month = this.layout[this._previewIndex].month;
            this._hideBubble();
            this.jumpTo(month);
        } else if (e.key === 'Escape') {
            this._hideBubble();
        }
    },

    jumpTo(month) {
        const newest = this.layout[0]?.month;
        State.set({
            jumpTo: month === newest ? null : month,
            page: 1,
            assets: [],
            hasMore: true,
        });
        window.scrollTo({ top: 0 });
        Gallery.load();
    },

    /** "2017-04" → "Apr '17" */
    monthLabel(month) {
        const [year, mon] = month.split('-').map(Number);
        const name = new Date(year, mon - 1, 1).toLocaleDateString(undefined, { month: 'short' });
        return `${name} ${this.shortYear(year)}`;
    },

    /** 2018 → "'18" */
    shortYear(year) {
        return `\u2019${String(year).slice(-2)}`;
    },

    _scheduleIndicator() {
        if (this._scrollFrame || !this.el.rail || this.el.rail.hidden) return;
        this._scrollFrame = window.requestAnimationFrame(() => {
            this._scrollFrame = 0;
            this._updateIndicator();
        });
    },

    /** The month of the day group at the top of the screen (just under the header). */
    _currentIndex() {
        const header = document.querySelector('.header');
        const y = (header ? header.getBoundingClientRect().bottom : 0) + 12;
        const probe = document.elementFromPoint(window.innerWidth / 2, Math.min(y, window.innerHeight - 1));
        const group = probe?.closest?.('.day-group') || document.querySelector('.day-group');
        const month = group?.dataset.day?.slice(0, 7);
        const index = month ? this.layout.findIndex((entry) => entry.month <= month) : -1;
        return index >= 0 ? index : 0;
    },

    _updateIndicator() {
        if (!this.layout.length || !this.el.indicator) return;
        this.el.indicator.style.top = this._placeAt(this.layout[this._currentIndex()]);
    },

    /** Pixel offset for a month's middle, kept far enough in that the whole handle shows. */
    _placeAt(entry) {
        const height = this.el.rail.clientHeight || 1;
        const half = (this.el.indicator.offsetHeight || 0) / 2;
        const y = (entry.top + entry.height / 2) * height;
        return `${Math.round(Math.min(Math.max(y, half), height - half))}px`;
    },

    /** Touch: slide the tab in while scrolling, tuck it away once things are still. */
    _wake() {
        const rail = this.el.rail;
        if (!rail || rail.hidden) return;
        rail.classList.add('active');
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => {
            if (!this._dragging) rail.classList.remove('active');
        }, 1800);
    },
};

window.Scrubber = Scrubber;
