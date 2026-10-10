/**
 * Timeline scrubber: a scroll bar with years on it. Its length is the whole page, so
 * dragging it simply scrolls; the bubble names the month you're over. Shown only while
 * the scrolling timeline is on screen (the library or one person, not search results).
 *
 * Desktop: the whole rail is grabbable and the years are always visible. Touch: only a
 * tab on the edge is, so thumbs scrolling near the edge aren't hijacked; it slides in
 * while scrolling, and the years show while dragging it.
 */

const Scrubber = {
    el: {
        rail: null,
        labels: null,
        indicator: null,
        bubble: null,
    },

    _attached: false,
    _dragging: false,
    _frame: 0,
    _indicatorFrame: 0,
    _idleTimer: 0,
    _focusMonth: -1, // keyboard: the month the arrows are stepping through

    init() {
        this.el.rail = document.getElementById('scrubber');
        if (!this.el.rail) return;
        this.el.labels = document.getElementById('scrubber-labels');
        this.el.indicator = document.getElementById('scrubber-indicator');
        this.el.bubble = document.getElementById('scrubber-bubble');

        const rail = this.el.rail;
        rail.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        rail.addEventListener('pointermove', (e) => {
            if (this._dragging) this._dragTo(e.clientY);
        });
        rail.addEventListener('pointerup', () => this._endDrag());
        rail.addEventListener('pointercancel', () => this._endDrag());
        rail.addEventListener('keydown', (e) => this._onKeyDown(e));
        rail.addEventListener('blur', () => this._hideBubble());

        window.addEventListener(
            'scroll',
            () => {
                if (!this._attached) return;
                if (!this._dragging) this._focusMonth = -1;
                this._scheduleIndicator();
                this._wake();
            },
            { passive: true }
        );
        window.addEventListener('resize', () => {
            if (!this._attached) return;
            this._placeRail();
            this.layoutChanged();
        });
    },

    attach() {
        if (!this.el.rail) return;
        if (Timeline.months.length < 2) {
            this.detach(); // a single month has nothing to scrub
            return;
        }
        this._attached = true;
        this.el.rail.hidden = false;
        document.body.classList.add('has-scrubber');
        this._placeRail();
        this._renderLabels();
        this._updateIndicator();
    },

    detach() {
        if (!this.el.rail) return;
        this._attached = false;
        this._dragging = false;
        this.el.rail.hidden = true;
        this.el.rail.classList.remove('dragging', 'active');
        document.body.classList.remove('has-scrubber');
        this._hideBubble();
    },

    isDragging() {
        return this._dragging;
    },

    /** Month heights changed: re-place the years and the indicator. */
    layoutChanged() {
        if (!this._attached || this._frame) return;
        this._frame = requestAnimationFrame(() => {
            this._frame = 0;
            this._renderLabels();
            this._updateIndicator();
        });
    },

    // ---- Geometry: rail fraction ↔ page scroll ↔ month ----

    _maxScroll() {
        return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    },

    _monthTop(month) {
        return month.el.getBoundingClientRect().top + window.scrollY;
    },

    /** Index of the month at a page scroll position. */
    _monthAt(scrollY) {
        const months = Timeline.months;
        let found = 0;
        for (let i = 0; i < months.length; i += 1) {
            if (this._monthTop(months[i]) <= scrollY + 1) found = i;
            else break;
        }
        return found;
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
        const max = this._maxScroll();
        const minGap = 18;
        const fragment = document.createDocumentFragment();
        let lastYear = null;
        let lastY = -Infinity;

        Timeline.months.forEach((month) => {
            const year = month.month.slice(0, 4);
            if (year === lastYear) return;
            lastYear = year;
            const fraction = Math.min(1, this._monthTop(month) / max);
            const y = fraction * height;
            if (y - lastY < minGap) return;
            lastY = y;

            const label = document.createElement('span');
            label.textContent = this.shortYear(year);
            label.style.top = `${(fraction * 100).toFixed(3)}%`;
            fragment.appendChild(label);
        });

        this.el.labels.replaceChildren(fragment);
    },

    /** Pixel offset on the rail, kept far enough in that the whole handle shows. */
    _railOffset(fraction) {
        const height = this.el.rail.clientHeight || 1;
        const half = (this.el.indicator.offsetHeight || 0) / 2;
        const y = fraction * height;
        return `${Math.round(Math.min(Math.max(y, half), height - half))}px`;
    },

    _scheduleIndicator() {
        if (this._indicatorFrame) return;
        this._indicatorFrame = requestAnimationFrame(() => {
            this._indicatorFrame = 0;
            this._updateIndicator();
        });
    },

    _updateIndicator() {
        if (!this._attached || this._dragging) return;
        const fraction = Math.min(1, window.scrollY / this._maxScroll());
        this.el.indicator.style.top = this._railOffset(fraction);
        const index = this._monthAt(window.scrollY);
        const month = Timeline.months[index];
        this.el.rail.setAttribute('aria-valuemin', '0');
        this.el.rail.setAttribute('aria-valuemax', String(Timeline.months.length - 1));
        this.el.rail.setAttribute('aria-valuenow', String(index));
        if (month) this.el.rail.setAttribute('aria-valuetext', this.monthLabel(month.month));
    },

    // ---- Dragging ----

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
        this._dragTo(e.clientY);
    },

    _dragTo(clientY) {
        const rect = this.el.rail.getBoundingClientRect();
        const fraction = Math.min(Math.max((clientY - rect.top) / (rect.height || 1), 0), 1);
        const top = Math.round(fraction * this._maxScroll());
        window.scrollTo({ top, behavior: 'instant' });

        const offset = this._railOffset(fraction);
        this.el.indicator.style.top = offset; // the handle follows the finger
        const month = Timeline.months[this._monthAt(top)];
        if (month) this._showBubble(this.monthLabel(month.month), offset);
    },

    _endDrag() {
        if (!this._dragging) return;
        this._dragging = false;
        this.el.rail.classList.remove('dragging');
        this._hideBubble();
        this._updateIndicator();
        this._wake();
        Timeline._schedule(); // now load what we landed on
    },

    _showBubble(text, top) {
        this.el.bubble.textContent = text;
        this.el.bubble.style.top = top;
        this.el.bubble.hidden = false;
        this.el.rail.setAttribute('aria-valuetext', text);
    },

    _hideBubble() {
        if (this.el.bubble) this.el.bubble.hidden = true;
    },

    // ---- Keyboard ----

    _onKeyDown(e) {
        const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 12, PageUp: -12 };
        const last = Timeline.months.length - 1;
        if (!(e.key in steps) && e.key !== 'Home' && e.key !== 'End' && e.key !== 'Escape') return;
        e.preventDefault();
        if (e.key === 'Escape') {
            this._hideBubble();
            return;
        }

        let index = this._focusMonth >= 0 ? this._focusMonth : this._monthAt(window.scrollY);
        if (e.key === 'Home') index = 0;
        else if (e.key === 'End') index = last;
        else index = Math.min(Math.max(index + steps[e.key], 0), last);

        const month = Timeline.months[index];
        window.scrollTo({ top: Math.ceil(this._monthTop(month)), behavior: 'instant' });
        this._focusMonth = index;
        const fraction = Math.min(1, window.scrollY / this._maxScroll());
        this._showBubble(this.monthLabel(month.month), this._railOffset(fraction));
    },

    // ---- Touch: slide the tab in while scrolling, tuck it away once things are still ----

    _wake() {
        const rail = this.el.rail;
        if (!rail || rail.hidden) return;
        rail.classList.add('active');
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => {
            if (!this._dragging) rail.classList.remove('active');
        }, 1800);
    },

    // ---- Labels ----

    /** "2017-04" → "Apr ’17" */
    monthLabel(month) {
        const [year, mon] = month.split('-').map(Number);
        const name = new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString(undefined, {
            month: 'short',
            timeZone: 'UTC',
        });
        return `${name} ${this.shortYear(year)}`;
    },

    /** 2018 → "’18" */
    shortYear(year) {
        return `’${String(year).slice(-2)}`;
    },
};

window.Scrubber = Scrubber;
