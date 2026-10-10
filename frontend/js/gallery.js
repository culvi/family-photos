/**
 * Day-grouped photo grid with infinite scroll.
 */

const Gallery = {
    elements: {
        gallery: null,
        galleryLoading: null,
        loadMoreContainer: null,
        loadMoreBtn: null,
        loadingIndicator: null,
        emptyState: null,
        errorState: null,
        errorMessage: null,
        retryBtn: null,
        resultCount: null,
        activeFilters: null,
    },

    observer: null,
    imageObserver: null,
    _visibleImages: null,
    _gridLoadingPaused: false,
    IMAGE_MARGIN: '200px',

    init() {
        this.elements.gallery = document.getElementById('timeline');
        this.elements.galleryLoading = document.getElementById('gallery-loading');
        this.elements.loadMoreContainer = document.getElementById('load-more-container');
        this.elements.loadMoreBtn = document.getElementById('load-more-btn');
        this.elements.loadingIndicator = document.getElementById('loading-indicator');
        this.elements.emptyState = document.getElementById('empty-state');
        this.elements.errorState = document.getElementById('error-state');
        this.elements.errorMessage = document.getElementById('error-message');
        this.elements.retryBtn = document.getElementById('retry-btn');
        this.elements.resultCount = document.getElementById('result-count');
        this.elements.activeFilters = document.getElementById('active-filters');

        this.elements.loadMoreBtn?.addEventListener('click', () => this.loadMore());
        this.elements.retryBtn?.addEventListener('click', () => this.reload());

        this.setupInfiniteScroll();

        State.subscribe((newState, oldState) => {
            this.onStateChange(newState, oldState);
        });
    },

    setupInfiniteScroll() {
        this.observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (
                    entry.isIntersecting &&
                    !State.getProperty('isLoadingMore') &&
                    State.getProperty('hasMore')
                ) {
                    this.loadMore();
                }
            },
            { rootMargin: '200px' },
        );

        if (this.elements.loadMoreContainer) {
            this.observer.observe(this.elements.loadMoreContainer);
        }
    },

    onStateChange(newState, oldState) {
        if (newState.isLoading !== oldState.isLoading) {
            this.elements.galleryLoading.hidden =
                !newState.isLoading || newState.assets.length > 0;
        }

        if (
            newState.total !== oldState.total ||
            newState.isLoading !== oldState.isLoading ||
            newState.assets.length !== oldState.assets.length
        ) {
            this.updateResultCount(newState);
        }

        this.updateActiveFilters(newState);

        if (newState.lightboxAssetId !== oldState.lightboxAssetId) {
            if (newState.lightboxAssetId) {
                this.pauseImageLoading();
            } else {
                this.resumeImageLoading();
            }
        }
    },

    /** Observe tile images individually so sources are assigned only near the
     *  viewport, with a short margin so scrolling stays ahead of the fetch. */
    setupImageLoading() {
        this._visibleImages = new Set();
        this.imageObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        this._visibleImages.add(entry.target);
                        this.loadGalleryImage(entry.target);
                    } else {
                        this._visibleImages.delete(entry.target);
                    }
                });
            },
            { rootMargin: this.IMAGE_MARGIN },
        );
    },

    observeGalleryImage(img) {
        if (this.imageObserver) this.imageObserver.observe(img);
    },

    /** Dense/comfortable grids are small enough for Immich's thumbnail;
     *  large mode uses its bigger preview. Never the original. */
    thumbnailSize() {
        return document.documentElement.dataset.view === 'large' ? 'preview' : 'thumbnail';
    },

    loadGalleryImage(img) {
        if (this._gridLoadingPaused) return;
        const desired = img.dataset.src;
        if (!desired || img.getAttribute('src') === desired) return;
        delete img.dataset.loaded;
        img.src = desired;
    },

    /** Re-point every tile after a density change; only visible tiles refetch. */
    refreshImageSources() {
        const size = this.thumbnailSize();
        const gallery = this.elements.gallery;
        if (!gallery) return;

        gallery.querySelectorAll('.gallery-item img').forEach((img) => {
            if (!img.dataset.assetId) return;
            const nextSrc = API.getThumbnailUrl(img.dataset.assetId, size);
            if (nextSrc === img.dataset.src) return;

            img.dataset.src = nextSrc;
            if (this._visibleImages?.has(img)) this.loadGalleryImage(img);
        });
    },

    /** While a photo is open, give it the connection: drop unfinished tile
     *  requests and leave already-rendered tiles untouched. */
    pauseImageLoading() {
        this._gridLoadingPaused = true;
        const gallery = this.elements.gallery;
        if (!gallery) return;

        gallery.querySelectorAll('.gallery-item img').forEach((img) => {
            if (img.dataset.loaded === '1') return;
            if (img.getAttribute('src')) img.removeAttribute('src');
        });
    },

    resumeImageLoading() {
        this._gridLoadingPaused = false;
        if (!this._visibleImages) return;

        this._visibleImages.forEach((img) => this.loadGalleryImage(img));
    },

    async load() {
        State.set({ isLoading: true, error: null });
        this.showLoading();

        // Date-ordered views (the library, one person) scroll as one continuous timeline.
        if (await Timeline.load()) {
            this.hideEmpty();
            this.hideError();
            this.elements.loadMoreContainer.hidden = true;
            State.set({ assets: [], total: Timeline.total, page: 1, hasMore: false, isLoading: false });
            this.updateResultCount(State.get());
            State.syncToURL();
            return;
        }

        try {
            const payload = State.buildSearchPayload(false);
            const response = await API.search(payload);

            State.set({
                assets: response.items || [],
                // Prefer API total (including 0); fall back to page length when omitted
                total: response.total ?? (response.items ? response.items.length : 0),
                page: response.page || 1,
                hasMore: response.hasMore !== false,
                isLoading: false,
            });

            this.render();
            State.syncToURL();
        } catch (error) {
            console.error('Failed to load assets:', error);
            State.set({ isLoading: false, error: error.message });
            this.showError(error.message);
        }
    },

    async loadMore() {
        if (State.getProperty('isLoadingMore') || !State.getProperty('hasMore')) {
            return;
        }

        State.set({ isLoadingMore: true });
        this.showLoadingMore();

        try {
            const payload = State.buildSearchPayload(true);
            const response = await API.search(payload);
            const currentAssets = State.getProperty('assets');
            const newAssets = response.items || [];

            State.set({
                assets: [...currentAssets, ...newAssets],
                page: response.page || State.getProperty('page') + 1,
                hasMore: response.hasMore !== false && newAssets.length > 0,
                isLoadingMore: false,
            });

            this.appendItems(newAssets);
        } catch (error) {
            console.error('Failed to load more assets:', error);
            State.set({ isLoadingMore: false });
        } finally {
            this.hideLoadingMore();
        }
    },

    reload() {
        this.load();
    },

    render() {
        const assets = State.getProperty('assets');
        this.clearGallery();

        if (assets.length === 0) {
            this.showEmpty();
            return;
        }

        this.hideEmpty();
        this.hideError();
        this.setupImageLoading();

        const fragment = document.createDocumentFragment();
        let currentKey = null;
        let grid = null;

        assets.forEach((asset, index) => {
            const key = this.groupKey(asset.localDateTime || asset.fileCreatedAt);
            if (key !== currentKey) {
                currentKey = key;
                const group = document.createElement('section');
                group.className = 'day-group';
                group.dataset.day = key;

                const header = document.createElement('h2');
                header.className = 'day-header';
                header.textContent = this.groupLabel(asset.localDateTime || asset.fileCreatedAt);
                group.appendChild(header);

                grid = document.createElement('div');
                grid.className = 'gallery';
                group.appendChild(grid);
                fragment.appendChild(group);
            }
            grid.appendChild(this.createGalleryItem(asset, index));
        });

        this.elements.gallery.appendChild(fragment);
        this.elements.loadMoreContainer.hidden = !State.getProperty('hasMore');
    },

    /** Append a page while continuing the last day group when dates match. */
    appendItems(assets) {
        const currentLength = State.getProperty('assets').length - assets.length;
        let grid = this.elements.gallery.querySelector('.day-group:last-of-type .gallery');
        let currentKey = null;

        if (grid) {
            const lastAsset = State.getProperty('assets')[currentLength - 1];
            currentKey = lastAsset
                ? this.groupKey(lastAsset.localDateTime || lastAsset.fileCreatedAt)
                : null;
        }

        assets.forEach((asset, index) => {
            const key = this.groupKey(asset.localDateTime || asset.fileCreatedAt);
            if (key !== currentKey || !grid) {
                currentKey = key;
                const group = document.createElement('section');
                group.className = 'day-group';
                group.dataset.day = key;

                const header = document.createElement('h2');
                header.className = 'day-header';
                header.textContent = this.groupLabel(asset.localDateTime || asset.fileCreatedAt);
                group.appendChild(header);

                grid = document.createElement('div');
                grid.className = 'gallery';
                group.appendChild(grid);
                this.elements.gallery.appendChild(group);
            }
            grid.appendChild(this.createGalleryItem(asset, currentLength + index));
        });

        this.elements.loadMoreContainer.hidden = !State.getProperty('hasMore');
    },

    /** The smallest size groups by month: a heading per day wastes a row on a few photos. */
    isMonthView() {
        return document.documentElement.dataset.view === 'dense';
    },

    groupKey(dateString) {
        const key = this.dayKey(dateString);
        return this.isMonthView() && key !== 'unknown' ? key.slice(0, 7) : key;
    },

    groupLabel(dateString) {
        if (!this.isMonthView()) return this.dayLabel(dateString);
        const d = new Date(dateString);
        if (!dateString || Number.isNaN(d.getTime())) return 'Unknown';
        return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    },

    /** Size changed: swap image sizes, and regroup when switching to/from months. */
    onViewModeChange(next, previous) {
        this.refreshImageSources();
        if (Timeline.active) {
            Timeline.relayout();
            return;
        }
        const monthsChanged = (next === 'dense') !== (previous === 'dense');
        if (monthsChanged && State.getProperty('assets').length) this.render();
    },

    /** The photo at screen height `y` (default: the first one under the header). */
    captureAnchor(y = null) {
        const header = document.querySelector('.header');
        const top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
        let item = null;
        if (y !== null) {
            item = document.elementFromPoint(window.innerWidth / 2, y)?.closest?.('.gallery-item');
        }
        if (!item) {
            item = [...document.querySelectorAll('.gallery-item')].find(
                (el) => el.getBoundingClientRect().bottom > top + 1
            );
        }
        if (!item) return null;
        return { id: item.dataset.assetId, top: item.getBoundingClientRect().top };
    },

    restoreAnchor(anchor) {
        if (!anchor) return;
        const item = document.querySelector(`.gallery-item[data-asset-id="${CSS.escape(anchor.id)}"]`);
        if (!item) return;
        window.scrollBy(0, item.getBoundingClientRect().top - anchor.top);
    },

    dayKey(dateString) {
        if (!dateString) return 'unknown';
        const d = new Date(dateString);
        if (Number.isNaN(d.getTime())) return 'unknown';
        // localDateTime is the clock time where the photo was taken, written with a Z:
        // read it as-is (UTC) rather than shifting it into this browser's time zone.
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    },

    dayLabel(dateString) {
        if (!dateString) return 'Unknown';
        try {
            const d = new Date(dateString);
            const now = new Date();
            const opts = { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' };
            if (d.getUTCFullYear() !== now.getFullYear()) {
                opts.year = 'numeric';
            }
            return d.toLocaleDateString(undefined, opts);
        } catch {
            return 'Unknown';
        }
    },

    createGalleryItem(asset, index, onOpen = () => Lightbox.open(asset, index)) {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.setAttribute('data-asset-id', asset.id);
        item.setAttribute('data-index', index);

        const img = document.createElement('img');
        img.className = 'loading';
        img.alt = asset.originalFileName || 'Photo';
        img.dataset.assetId = asset.id;
        img.dataset.src = API.getThumbnailUrl(asset.id, this.thumbnailSize());
        img.decoding = 'async';
        // Lower priority than a selected original so opening a photo wins the connection.
        img.fetchPriority = 'low';
        img.onload = () => {
            img.dataset.loaded = '1';
            img.classList.remove('loading');
        };
        img.onerror = () => {
            img.src =
                'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23ccc" width="100" height="100"/><text x="50" y="55" text-anchor="middle" fill="%23999" font-size="12">Error</text></svg>';
        };
        item.appendChild(img);
        this.observeGalleryImage(img);

        if (asset.type === 'VIDEO') {
            const indicator = document.createElement('div');
            indicator.className = 'video-indicator';
            indicator.innerHTML = `
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
            `;
            item.appendChild(indicator);
        }

        const overlay = document.createElement('div');
        overlay.className = 'gallery-item-overlay';
        overlay.textContent = this.formatDate(asset.localDateTime || asset.fileCreatedAt);
        item.appendChild(overlay);

        item.addEventListener('click', onOpen);
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen();
            }
        });

        return item;
    },

    formatDate(dateString) {
        if (!dateString) return '';
        try {
            return new Date(dateString).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
            });
        } catch {
            return '';
        }
    },

    /** A real total on the timeline (the whole library or one person); nothing for
     *  search results, which come a page at a time with no total. */
    updateResultCount(state) {
        let text = '';
        if (Timeline.active) {
            const total = Timeline.total;
            text = `${total.toLocaleString()} ${total === 1 ? 'photo' : 'photos & videos'}`;
        } else if (!state.isLoading && state.assets.length === 0) {
            text = 'No results';
        }
        this.elements.resultCount.textContent = text;
        this._syncStatusBar();
    },

    /** Collapse the row under the header when it has nothing to say. */
    _syncStatusBar() {
        const bar = document.getElementById('status-bar');
        if (!bar) return;
        bar.hidden = !this.elements.resultCount.textContent && !this.elements.activeFilters.children.length;
    },

    updateActiveFilters(state) {
        const container = this.elements.activeFilters;
        container.innerHTML = '';

        const filters = [];

        if (state.query) {
            filters.push({ label: `"${state.query}"`, key: 'query' });
        }

        if (state.personIds.length > 0) {
            const people = State.getProperty('people') || [];
            const peopleById = new Map(people.map((p) => [p.id, p]));

            state.personIds.forEach((id) => {
                const person = peopleById.get(id);
                const label = person?.name?.trim() || 'Unnamed person';
                filters.push({ label, key: 'person', value: id });
            });
        }

        if (state.dateFrom || state.dateTo) {
            const label =
                state.dateFrom && state.dateTo
                    ? `${state.dateFrom} - ${state.dateTo}`
                    : state.dateFrom
                      ? `From ${state.dateFrom}`
                      : `Until ${state.dateTo}`;
            filters.push({ label, key: 'date' });
        }

        if (state.mediaType !== 'ALL') {
            filters.push({
                label: state.mediaType === 'IMAGE' ? 'Photos' : 'Videos',
                key: 'mediaType',
            });
        }

        if (state.cameraMake) filters.push({ label: state.cameraMake, key: 'cameraMake' });
        if (state.cameraModel) filters.push({ label: state.cameraModel, key: 'cameraModel' });
        if (state.country) filters.push({ label: state.country, key: 'country' });
        if (state.city) filters.push({ label: state.city, key: 'city' });

        filters.forEach((filter) => {
            const tag = document.createElement('span');
            tag.className = 'filter-tag';
            tag.appendChild(document.createTextNode(filter.label));

            const button = document.createElement('button');
            button.setAttribute('aria-label', 'Remove filter');
            button.setAttribute('data-filter', filter.key);
            button.setAttribute('data-value', filter.value || '');
            button.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            `;
            button.addEventListener('click', () => {
                this.removeFilter(filter.key, filter.value);
            });
            tag.appendChild(button);
            container.appendChild(tag);
        });
        this._syncStatusBar();
    },

    removeFilter(key, value) {
        const updates = {};

        switch (key) {
            case 'query':
                updates.query = '';
                document.getElementById('search-input').value = '';
                break;
            case 'person': {
                const personIds = State.getProperty('personIds').filter((id) => id !== value);
                updates.personIds = personIds;
                Filters.updatePeopleChips(personIds);
                break;
            }
            case 'date':
                updates.dateFrom = null;
                updates.dateTo = null;
                document.getElementById('date-from').value = '';
                document.getElementById('date-to').value = '';
                break;
            case 'mediaType':
                updates.mediaType = 'ALL';
                document.querySelector('input[name="media-type"][value="ALL"]').checked = true;
                break;
            case 'cameraMake':
                updates.cameraMake = '';
                document.getElementById('camera-make').value = '';
                break;
            case 'cameraModel':
                updates.cameraModel = '';
                document.getElementById('camera-model').value = '';
                break;
            case 'country':
                updates.country = '';
                document.getElementById('location-country').value = '';
                break;
            case 'city':
                updates.city = '';
                document.getElementById('location-city').value = '';
                break;
        }

        updates.page = 1;
        updates.assets = [];
        updates.hasMore = true;

        State.set(updates);
        this.load();
    },

    clearGallery() {
        // Only the paged list's own groups; the scrolling timeline manages its months.
        this.elements.gallery.querySelectorAll(':scope > .day-group .gallery-item img').forEach((img) => {
            if (img.dataset.loaded === '1') return;
            img.removeAttribute('src');
        });

        this.imageObserver?.disconnect();
        this.imageObserver = null;
        this._visibleImages = new Set();

        this.elements.gallery.querySelectorAll(':scope > .day-group').forEach((el) => el.remove());
    },

    showLoading() {
        this.elements.galleryLoading.hidden = false;
        this.elements.emptyState.hidden = true;
        this.elements.errorState.hidden = true;
    },

    showLoadingMore() {
        this.elements.loadMoreBtn.hidden = true;
        this.elements.loadingIndicator.hidden = false;
    },

    hideLoadingMore() {
        this.elements.loadMoreBtn.hidden = false;
        this.elements.loadingIndicator.hidden = true;
    },

    showEmpty() {
        this.elements.galleryLoading.hidden = true;
        this.elements.emptyState.hidden = false;
        this.elements.errorState.hidden = true;
        this.elements.loadMoreContainer.hidden = true;
    },

    hideEmpty() {
        this.elements.emptyState.hidden = true;
    },

    showError(message) {
        this.elements.galleryLoading.hidden = true;
        this.elements.emptyState.hidden = true;
        this.elements.errorState.hidden = false;
        this.elements.errorMessage.textContent =
            message || 'Unable to load photos. Please try again.';
        this.elements.loadMoreContainer.hidden = true;
    },

    hideError() {
        this.elements.errorState.hidden = true;
    },
};

window.Gallery = Gallery;
