/**
 * The scrolling timeline: the whole library (or one person) as a single page, newest first.
 *
 * The page is full height from the start: each month is a section sized from Immich's
 * per-month count. A month's photos are fetched as it comes within a few screens and drawn
 * when it's about to scroll into view; months far away are emptied again (keeping their
 * height) so a phone never holds tens of thousands of tiles.
 *
 * Tiles are uniform, so once a month's photos are known its height is exact: day headings
 * plus rows of tiles, measured from a hidden probe. Until then it's an estimate. Every
 * height change goes through _mutate(), which keeps whatever is on screen exactly where it
 * was, so content never jumps when a month above settles. While the page is moving, changes
 * well above the screen wait until scrolling stops, so a fling isn't interrupted.
 *
 * Used only when the view is in date order and Immich can count it: no text search and no
 * filters other than a single person. Everything else stays on Gallery's paged list.
 */

const Timeline = {
    active: false,
    key: null, // 'all' or a person id
    months: [], // see _month()
    total: 0,

    RENDER_SCREENS: 1.5, // draw months within this many screens of the viewport
    DATA_SCREENS: 6, // fetch their photos within this many
    DROP_SCREENS: 4, // empty drawn months further than this
    MAX_FETCHES: 3,

    _container: null,
    _layout: null,
    _generation: 0,
    _fetching: 0,
    _frame: 0,
    _idleTimer: 0,
    _lastScroll: 0,
    _builtOnce: false,
    _width: 0,
    _perDay: 8, // learned average photos per day, for estimating unloaded months

    init() {
        const host = document.getElementById('timeline');
        if (!host) return;
        this._container = document.createElement('div');
        this._container.className = 'tl-months';
        this._container.hidden = true;
        host.appendChild(this._container);

        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

        window.addEventListener(
            'scroll',
            () => {
                this._lastScroll = performance.now();
                this._schedule();
            },
            { passive: true }
        );
        let resizeTimer = 0;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // Phones fire resize as the address bar shows/hides; only width changes layout.
                if (this.active && window.innerWidth !== this._width) this.relayout();
                else this._schedule();
            }, 150);
        });
    },

    /** 'all', a person id, or null when this view isn't a date-ordered timeline. */
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

    /** Build the timeline for the current view. False means Gallery should page instead. */
    async load() {
        const key = this.eligibleKey(State.get());
        const generation = ++this._generation;
        if (!key) {
            this.clear();
            return false;
        }

        let buckets = [];
        try {
            const response = await API.getTimelineBuckets(key === 'all' ? null : key);
            buckets = response.buckets || [];
        } catch (error) {
            console.error('Failed to load timeline:', error);
        }
        if (generation !== this._generation) return true; // a newer load owns the page
        if (!buckets.length) {
            this.clear(); // e.g. an album-scoped code: fall back to the paged list
            return false;
        }

        this._build(key, buckets);
        return true;
    },

    clear() {
        this._generation += 1;
        this._forEachImage((img) => {
            Gallery.imageObserver?.unobserve(img);
            if (img.dataset.loaded !== '1') img.removeAttribute('src');
        });
        if (this._container) {
            this._container.replaceChildren();
            this._container.hidden = true;
        }
        this.months = [];
        this.total = 0;
        this.key = null;
        if (this.active) {
            this.active = false;
            document.documentElement.style.overflowAnchor = '';
            Scrubber.detach();
        }
    },

    _build(key, buckets) {
        const generation = this._generation;
        this.clear();
        this._generation = generation; // clear() bumps it; this build is still current

        Gallery.clearGallery();
        Gallery.setupImageLoading();

        this.active = true;
        // We keep the screen steady ourselves; the browser's own scroll anchoring would
        // correct the same change a second time.
        document.documentElement.style.overflowAnchor = 'none';
        this.key = key;
        this.total = buckets.reduce((sum, b) => sum + b.count, 0);
        this._container.hidden = false;

        const fragment = document.createDocumentFragment();
        this.months = buckets.map((bucket) => {
            const month = this._month(bucket);
            month.el.style.height = `${bucket.count * 50}px`; // rough, so the page is long
            fragment.appendChild(month.el);
            return month;
        });
        this._container.appendChild(fragment);
        // Measure only now: the page's scrollbar (desktop) and the scrubber's gutter both
        // narrow the tiles.
        Scrubber.attach();
        this._measure();
        this.months.forEach((month) => this._setHeight(month, this._estimate(month)));

        if (this._builtOnce) window.scrollTo({ top: 0 });
        this._builtOnce = true;

        Scrubber.layoutChanged();
        this._update();
    },

    _month(bucket) {
        const el = document.createElement('section');
        el.className = 'tl-month';
        el.dataset.month = bucket.month;
        return {
            month: bucket.month,
            count: bucket.count,
            el,
            items: null,
            loading: null, // the in-flight fetch promise
            failures: 0,
            retryAt: 0,
            rendered: false,
            height: 0,
        };
    },

    // ---- Layout ----

    /** Measure a day group with one tile, using the real CSS, at the real width. */
    _measure() {
        const probe = document.createElement('section');
        probe.className = 'day-group';
        probe.style.cssText = 'visibility:hidden;position:absolute;left:0;right:0;top:0';
        probe.innerHTML = '<h2 class="day-header">Probe</h2><div class="gallery"><div class="gallery-item"></div></div>';
        this._container.prepend(probe);

        const grid = probe.querySelector('.gallery');
        const tile = grid.firstElementChild.getBoundingClientRect();
        const gridStyle = getComputedStyle(grid);
        const columns = gridStyle.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
        const gap = parseFloat(gridStyle.rowGap) || 0;
        const marginTop = parseFloat(getComputedStyle(probe).marginTop) || 0;
        const oneRow = probe.getBoundingClientRect().height;

        // Row pitch from three real rows, so the browser's rounding is included.
        for (let i = 1; i < columns * 2 + 1; i += 1) grid.appendChild(document.createElement('div')).className = 'gallery-item';
        const pitch = (probe.getBoundingClientRect().height - oneRow) / 2;
        probe.remove();

        this._width = window.innerWidth;
        this._layout = {
            columns,
            tileHeight: tile.height,
            tileWidth: tile.width,
            gap,
            pitch,
            fixed: oneRow - tile.height + marginTop,
        };

        const style = this._container.style;
        style.setProperty('--tl-tile-w', `${tile.width}px`);
        style.setProperty('--tl-tile-h', `${tile.height}px`);
        style.setProperty('--tl-gap', `${gap}px`);
    },

    _groupHeight(count) {
        const { columns, tileHeight, pitch, fixed } = this._layout;
        const rows = Math.max(1, Math.ceil(count / columns));
        return fixed + tileHeight + (rows - 1) * pitch;
    },

    /** Exact once the photos are known; otherwise from the count and an average day. */
    _estimate(month) {
        if (month.items) {
            return this._groups(month.items).reduce((sum, g) => sum + this._groupHeight(g.items.length), 0);
        }
        if (Gallery.isMonthView()) return this._groupHeight(month.count);
        const days = Math.max(1, Math.min(month.count, Math.round(month.count / this._perDay)));
        const perDay = month.count / days;
        return days * this._groupHeight(perDay);
    },

    _groups(items) {
        const groups = [];
        let current = null;
        items.forEach((item) => {
            const key = Gallery.groupKey(item.localDateTime);
            if (!current || current.key !== key) {
                current = { key, label: Gallery.groupLabel(item.localDateTime), items: [] };
                groups.push(current);
            }
            current.items.push(item);
        });
        return groups;
    },

    _setHeight(month, height) {
        month.height = height;
        month.el.style.height = `${height}px`;
    },

    /** Size or width changed: re-measure everything, keeping the screen where it was. */
    relayout() {
        if (!this.active) return;
        this._mutate(() => {
            this._measure();
            this.months.forEach((month) => {
                if (month.rendered) this._render(month);
                else this._setHeight(month, this._estimate(month));
            });
        });
        Scrubber.layoutChanged();
        this._schedule();
    },

    // ---- Keeping the screen steady ----

    /** Run fn (which may resize months) without moving what's on screen. */
    _mutate(fn) {
        const anchor = this._anchor();
        fn();
        if (!anchor) return;
        const delta = anchor.el.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    },

    /** The first tile (or month, if not drawn) at the top of the screen. */
    _anchor() {
        const month = this.months.find((m) => m.el.getBoundingClientRect().bottom > 0);
        if (!month) return null;
        let el = month.el;
        if (month.rendered) {
            const tile = [...month.el.querySelectorAll('.gallery-item')].find(
                (t) => t.getBoundingClientRect().bottom > 0
            );
            if (tile) el = tile;
        }
        return { el, top: el.getBoundingClientRect().top };
    },

    // ---- The update loop ----

    _schedule() {
        if (this._frame || !this.active) return;
        this._frame = requestAnimationFrame(() => {
            this._frame = 0;
            this._update();
        });
    },

    _update() {
        if (!this.active) return;
        // While the scrubber is being dragged, just let placeholders fly by.
        if (Scrubber.isDragging()) return;
        const screen = window.innerHeight;
        const moving = performance.now() - this._lastScroll < 150;
        let deferred = false;

        const plan = this.months.map((month) => {
            const rect = month.el.getBoundingClientRect();
            const distance = rect.bottom < 0 ? -rect.bottom : rect.top > screen ? rect.top - screen : 0;
            return { month, distance, above: rect.bottom <= 0 };
        });

        const changes = [];
        plan.forEach(({ month, distance, above }) => {
            const near = distance < screen * this.RENDER_SCREENS;
            if (month.rendered && distance > screen * this.DROP_SCREENS) {
                changes.push(() => this._unrender(month));
            } else if (month.items && !month.rendered && near) {
                changes.push(() => this._render(month));
            } else if (month.items && !month.rendered) {
                const exact = this._estimate(month);
                if (Math.abs(exact - month.height) > 0.5) {
                    if (above && moving) deferred = true; // settle it once scrolling stops
                    else changes.push(() => this._setHeight(month, exact));
                }
            }
        });
        if (changes.length) {
            this._mutate(() => changes.forEach((change) => change()));
            Scrubber.layoutChanged();
        }

        // Fetch nearest first.
        const now = performance.now();
        plan.filter(
            ({ month, distance }) =>
                !month.items && !month.loading && now >= month.retryAt && distance < screen * this.DATA_SCREENS
        )
            .sort((a, b) => a.distance - b.distance)
            .slice(0, Math.max(0, this.MAX_FETCHES - this._fetching))
            .forEach(({ month }) => this._fetch(month));

        clearTimeout(this._idleTimer);
        if (deferred || moving) this._idleTimer = setTimeout(() => this._update(), 200);
    },

    // ---- Data ----

    _fetch(month) {
        if (month.items) return Promise.resolve(month.items);
        if (month.loading) return month.loading;

        const generation = this._generation;
        this._fetching += 1;
        month.loading = API.getTimelineMonth(month.month, this.key === 'all' ? null : this.key)
            .then((response) => {
                if (generation !== this._generation) return null;
                month.items = (response.items || []).map((item, index) => ({
                    ...item,
                    partial: true, // the lightbox fetches full details before showing it
                    _month: month,
                    _index: index,
                }));
                month.failures = 0;
                this._learn();
                return month.items;
            })
            .catch((error) => {
                if (generation !== this._generation) return null;
                month.failures += 1;
                month.retryAt = performance.now() + Math.min(30000, 2000 * month.failures);
                console.error(`Failed to load ${month.month}:`, error);
                return null;
            })
            .finally(() => {
                month.loading = null;
                this._fetching -= 1;
                this._schedule();
            });
        return month.loading;
    },

    /** Refine the photos-per-day guess from months already loaded. */
    _learn() {
        let photos = 0;
        let days = 0;
        this.months.forEach((month) => {
            if (!month.items) return;
            photos += month.items.length;
            days += new Set(month.items.map((item) => Gallery.dayKey(item.localDateTime))).size;
        });
        if (days) this._perDay = Math.max(1, photos / days);
    },

    // ---- Drawing ----

    _render(month) {
        this._dropImages(month);
        const fragment = document.createDocumentFragment();
        this._groups(month.items).forEach((group) => {
            const section = document.createElement('section');
            section.className = 'day-group';
            section.dataset.day = group.key;

            const header = document.createElement('h2');
            header.className = 'day-header';
            header.textContent = group.label;
            section.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'gallery';
            group.items.forEach((item) => {
                grid.appendChild(Gallery.createGalleryItem(item, item._index, () => this.open(item)));
            });
            section.appendChild(grid);
            fragment.appendChild(section);
        });
        month.el.replaceChildren(fragment);
        month.el.style.height = '';
        month.el.classList.add('rendered');
        month.rendered = true;
        month.height = month.el.getBoundingClientRect().height;
    },

    _unrender(month) {
        const height = month.el.getBoundingClientRect().height;
        this._dropImages(month);
        month.el.replaceChildren();
        month.el.classList.remove('rendered');
        month.rendered = false;
        this._setHeight(month, height);
    },

    _dropImages(month) {
        month.el.querySelectorAll('.gallery-item img').forEach((img) => {
            Gallery.imageObserver?.unobserve(img);
            Gallery._visibleImages?.delete(img);
            if (img.dataset.loaded !== '1') img.removeAttribute('src');
        });
    },

    _forEachImage(fn) {
        this._container?.querySelectorAll('.gallery-item img').forEach(fn);
    },

    // ---- Lightbox navigation (newest → oldest, across months) ----

    open(item) {
        Lightbox.open(item, item._index, this);
    },

    hasPrevious(item) {
        const index = this.months.indexOf(item._month);
        return index > 0 || item._index > 0;
    },

    hasNext(item) {
        const index = this.months.indexOf(item._month);
        return index < this.months.length - 1 || item._index < item._month.items.length - 1;
    },

    async previous(item) {
        if (item._index > 0) return item._month.items[item._index - 1];
        for (let i = this.months.indexOf(item._month) - 1; i >= 0; i -= 1) {
            const items = await this._fetch(this.months[i]);
            if (items?.length) return items[items.length - 1];
            if (!items) return null;
        }
        return null;
    },

    async next(item) {
        if (item._index < item._month.items.length - 1) return item._month.items[item._index + 1];
        for (let i = this.months.indexOf(item._month) + 1; i < this.months.length; i += 1) {
            const items = await this._fetch(this.months[i]);
            if (items?.length) return items[0];
            if (!items) return null;
        }
        return null;
    },

    /** After the lightbox closes: make sure the last photo viewed is on screen. */
    reveal(item) {
        const month = item?._month;
        if (!month || !this.months.includes(month) || !month.items) return;
        if (!month.rendered) this._mutate(() => this._render(month));
        const tile = month.el.querySelector(`.gallery-item[data-asset-id="${CSS.escape(item.id)}"]`);
        if (!tile) return;
        const rect = tile.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            tile.scrollIntoView({ block: 'center' });
        }
        this._schedule();
    },
};

window.Timeline = Timeline;
