/**
 * Central app state with URL sync for shareable filter links.
 */

const State = {
    _state: {
        // Filters
        query: '',
        personIds: [],
        dateFrom: null,
        dateTo: null,
        mediaType: 'ALL',
        cameraMake: '',
        cameraModel: '',
        country: '',
        city: '',

        // Scrubber jump: start the list at this month ("YYYY-MM"). Older photos page in
        // below as usual; newer ones page in above when scrolling up. Not a filter: no
        // chip, not counted in the badge or written to the URL.
        jumpTo: null,
        newerPage: 0,
        hasNewer: false,
        isLoadingNewer: false,

        // Pagination
        page: 1,
        size: 50,
        hasMore: true,
        total: 0,

        // Assets + UI
        assets: [],
        isLoading: false,
        isLoadingMore: false,
        error: null,

        // Lightbox
        lightboxAssetId: null,
        lightboxIndex: -1,

        // Cached reference data
        people: [],
        suggestions: null,
    },

    _subscribers: [],

    get() {
        return { ...this._state };
    },

    getProperty(key) {
        return this._state[key];
    },

    set(updates) {
        const oldState = { ...this._state };
        this._state = { ...this._state, ...updates };
        this._subscribers.forEach((callback) => {
            callback(this._state, oldState);
        });
    },

    subscribe(callback) {
        this._subscribers.push(callback);
        return () => {
            this._subscribers = this._subscribers.filter((cb) => cb !== callback);
        };
    },

    // --- URL sync ---

    toURLParams() {
        const params = new URLSearchParams();
        const s = this._state;

        if (s.query) params.set('q', s.query);
        if (s.personIds.length > 0) params.set('people', s.personIds.join(','));
        if (s.dateFrom) params.set('from', s.dateFrom);
        if (s.dateTo) params.set('to', s.dateTo);
        if (s.mediaType !== 'ALL') params.set('type', s.mediaType);
        if (s.cameraMake) params.set('make', s.cameraMake);
        if (s.cameraModel) params.set('model', s.cameraModel);
        if (s.country) params.set('country', s.country);
        if (s.city) params.set('city', s.city);

        return params;
    },

    syncToURL() {
        const params = this.toURLParams();
        const newUrl = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;
        window.history.replaceState({}, '', newUrl);
    },

    loadFromURL() {
        const params = new URLSearchParams(window.location.search);
        const updates = {};

        if (params.has('q')) updates.query = params.get('q');
        if (params.has('people')) {
            updates.personIds = params.get('people').split(',').filter(Boolean);
        }
        if (params.has('from')) updates.dateFrom = params.get('from');
        if (params.has('to')) updates.dateTo = params.get('to');
        if (params.has('type')) updates.mediaType = params.get('type');
        if (params.has('make')) updates.cameraMake = params.get('make');
        if (params.has('model')) updates.cameraModel = params.get('model');
        if (params.has('country')) updates.country = params.get('country');
        if (params.has('city')) updates.city = params.get('city');

        if (Object.keys(updates).length > 0) {
            this.set(updates);
        }
    },

    // --- Filters ---

    getActiveFilterCount() {
        const s = this._state;
        let count = 0;
        if (s.query) count++;
        if (s.personIds.length > 0) count++;
        if (s.dateFrom || s.dateTo) count++;
        if (s.mediaType !== 'ALL') count++;
        if (s.cameraMake) count++;
        if (s.cameraModel) count++;
        if (s.country || s.city) count++;
        return count;
    },

    clearFilters() {
        this.set({
            query: '',
            personIds: [],
            dateFrom: null,
            dateTo: null,
            mediaType: 'ALL',
            cameraMake: '',
            cameraModel: '',
            country: '',
            city: '',
            jumpTo: null,
            newerPage: 0,
            hasNewer: false,
            page: 1,
            assets: [],
            hasMore: true,
        });
        this.syncToURL();
    },

    /** "2012-03" -> "2012-03-31T23:59:59.999Z" (null passes through). */
    endOfMonth(month) {
        if (!month) return null;
        const [year, mon] = month.split('-').map(Number);
        return new Date(Date.UTC(year, mon, 0, 23, 59, 59, 999)).toISOString();
    },

    /** The next page of photos just newer than the jump point, oldest first. */
    buildNewerPayload() {
        const s = this._state;
        return {
            ...this.buildSearchPayload(false),
            takenBefore: null,
            takenAfter: this.endOfMonth(s.jumpTo),
            order: 'asc',
            page: s.newerPage + 1,
            size: 100,
        };
    },

    buildSearchPayload(loadMore = false) {
        const s = this._state;
        return {
            query: s.query || null,
            personIds: s.personIds.length > 0 ? s.personIds : null,
            takenAfter: s.dateFrom || null,
            takenBefore: s.dateTo || this.endOfMonth(s.jumpTo),
            type: s.mediaType !== 'ALL' ? s.mediaType : null,
            make: s.cameraMake || null,
            model: s.cameraModel || null,
            country: s.country || null,
            city: s.city || null,
            page: loadMore ? s.page + 1 : 1,
            size: s.size,
        };
    },
};

window.State = State;
