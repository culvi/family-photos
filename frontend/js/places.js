/**
 * Places: a map of where photos were taken, with the photos in view listed below it
 * (beside it on wide screens), newest first.
 *
 * Pins come from Immich's map markers (timeline photos only) and cluster as you zoom out;
 * tap a cluster to zoom in, tap a pin or a photo to open it. The map library (MapLibre,
 * vendored) and Immich's map style load only the first time the page opens.
 */

const Places = {
    el: {},
    isOpen: false,
    _pushedHistory: false,
    map: null,
    markers: null, // {ids: [], lat: [], lon: []}, newest first
    _ready: null, // promise for the first open's setup
    _inView: [], // marker indices inside the map's view, newest first
    _shown: 0, // how many of them have tiles
    PAGE: 90,

    init() {
        const $ = (id) => document.getElementById(id);
        this.el = {
            toggle: $('map-toggle'),
            page: $('map-page'),
            close: $('map-close'),
            count: $('map-count'),
            canvas: $('map-canvas'),
            status: $('map-status'),
            photos: $('map-photos'),
            title: $('map-photos-title'),
            grid: $('map-photos-grid'),
        };
        if (!this.el.page) return;

        this.el.toggle?.addEventListener('click', () => this.open());
        this.el.close?.addEventListener('click', () => this.close());
        // Capture phase: runs before the lightbox's own Escape handler, so Escape with a
        // photo open closes just the photo.
        window.addEventListener(
            'keydown',
            (e) => {
                if (e.key !== 'Escape' || !this.isOpen) return;
                if (!document.getElementById('lightbox')?.hidden) return;
                this.close();
            },
            true
        );
        window.addEventListener('popstate', () => {
            if (this.isOpen) this.hide();
        });
        this.el.photos.addEventListener('scroll', () => this._maybeShowMore(), { passive: true });
    },

    async open() {
        if (this.isOpen) return;
        this.isOpen = true;
        this.el.page.hidden = false;
        document.body.style.overflow = 'hidden';
        this.el.toggle?.setAttribute('aria-expanded', 'true');
        window.history.pushState({ placesPage: true }, '');
        this._pushedHistory = true;

        if (!this._ready) this._ready = this._setup();
        try {
            await this._ready;
            this.map?.resize();
        } catch (error) {
            console.error('Map failed to load:', error);
            this._ready = null; // try again next time
            this._status('Couldn’t load the map. Close and try again.');
        }
    },

    /** Close via history when we pushed an entry, so a phone's back gesture works too. */
    close() {
        if (!this.isOpen) return;
        if (this._pushedHistory) window.history.back(); // popstate → hide()
        else this.hide();
    },

    hide() {
        this.isOpen = false;
        this._pushedHistory = false;
        this.el.page.hidden = true;
        document.body.style.overflow = '';
        this.el.toggle?.setAttribute('aria-expanded', 'false');
    },

    _status(text) {
        this.el.status.textContent = text || '';
        this.el.status.hidden = !text;
    },

    // ---- Setup ----

    async _setup() {
        this._status('Loading map…');
        const [markers, style] = await Promise.all([
            API.get('/map/markers'),
            API.get('/map/style'),
            this._loadLibrary(),
        ]);
        this.markers = markers;
        const total = markers.ids.length;
        this.el.count.textContent = total ? `${total.toLocaleString()} photos with a location` : '';

        const dark = window.matchMedia('(prefers-color-scheme: dark)');
        const styleFor = () => (dark.matches ? style.dark : style.light);

        const map = new maplibregl.Map({
            container: this.el.canvas,
            style: styleFor(),
            center: [-40, 30],
            zoom: 1,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            attributionControl: { compact: true },
        });
        map.touchZoomRotate.disableRotation();
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        this.map = map;

        // Layers go on with every style (the first, and after a light/dark switch).
        map.on('style.load', () => this._addLayers());
        dark.addEventListener('change', () => map.setStyle(styleFor()));

        await new Promise((resolve) => {
            // 'load' can go missing (e.g. when a font fails); 'idle' always follows a render.
            const done = () => {
                clearInterval(poll);
                resolve();
            };
            const poll = setInterval(() => map.loaded() && done(), 250);
            map.once('load', done);
            map.once('idle', done);
        });
        this._status(total ? '' : 'No photos have a location yet.');
        if (total) this._fitAll();

        map.on('click', 'places-clusters', (e) => this._zoomInto(e));
        map.on('click', 'places-points', (e) => {
            const index = e.features?.[0]?.properties?.i;
            if (Number.isInteger(index)) this._openMarker(index);
        });
        ['places-clusters', 'places-points'].forEach((layer) => {
            map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
            map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
        });
        map.on('moveend', () => this._updateInView());
        this._updateInView();
    },

    _loadLibrary() {
        if (window.maplibregl) return Promise.resolve();
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'vendor/maplibre/maplibre-gl.css';
        document.head.appendChild(css);
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'vendor/maplibre/maplibre-gl-csp.js';
            script.onload = () => {
                // The CSP build runs its worker from a file (no blob: workers needed).
                maplibregl.setWorkerUrl(new URL('vendor/maplibre/maplibre-gl-csp-worker.js', location.href).href);
                resolve();
            };
            script.onerror = () => reject(new Error('map library failed to load'));
            document.head.appendChild(script);
        });
    },

    _geojson() {
        const { ids, lat, lon } = this.markers;
        return {
            type: 'FeatureCollection',
            features: ids.map((_, i) => ({
                type: 'Feature',
                properties: { i },
                geometry: { type: 'Point', coordinates: [lon[i], lat[i]] },
            })),
        };
    },

    _addLayers() {
        const map = this.map;
        if (!map || !this.markers || map.getSource('places')) return;
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#4250af';

        const data = this._geojson();
        const clustering = { type: 'geojson', data, cluster: true, clusterRadius: 44, clusterMaxZoom: 15 };
        map.addSource('places', clustering);
        // The numbers get their own copy: if the style's font can't load, only they go
        // missing, not the pins (MapLibre builds a source's layers together).
        map.addSource('places-labels', { ...clustering });
        map.addLayer({
            id: 'places-clusters',
            type: 'circle',
            source: 'places',
            filter: ['has', 'point_count'],
            paint: {
                'circle-color': accent,
                'circle-opacity': 0.9,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 250, 23, 2500, 29],
            },
        });
        map.addLayer({
            id: 'places-count',
            type: 'symbol',
            source: 'places-labels',
            filter: ['has', 'point_count'],
            layout: {
                'text-field': ['get', 'point_count_abbreviated'],
                'text-size': 12,
                'text-allow-overlap': true,
                ...(this._fontFor(map) ? { 'text-font': this._fontFor(map) } : {}),
            },
            paint: { 'text-color': '#ffffff' },
        });
        map.addLayer({
            id: 'places-points',
            type: 'circle',
            source: 'places',
            filter: ['!', ['has', 'point_count']],
            paint: {
                'circle-color': accent,
                'circle-radius': 7,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
            },
        });
    },

    /** Reuse a font the style already uses for its own labels, so the counts can draw. */
    _fontFor(map) {
        const layer = map.getStyle().layers.find((l) => l.type === 'symbol' && l.layout?.['text-font']);
        const font = layer?.layout?.['text-font'];
        return Array.isArray(font) && font.every((f) => typeof f === 'string') ? font : null;
    },

    _fitAll() {
        const { lat, lon } = this.markers;
        let [w, s, e, n] = [180, 90, -180, -90];
        for (let i = 0; i < lat.length; i += 1) {
            if (lon[i] < w) w = lon[i];
            if (lon[i] > e) e = lon[i];
            if (lat[i] < s) s = lat[i];
            if (lat[i] > n) n = lat[i];
        }
        this.map.fitBounds(
            [
                [w, s],
                [e, n],
            ],
            { padding: 40, maxZoom: 12, duration: 0 }
        );
    },

    async _zoomInto(e) {
        const feature = e.features?.[0];
        if (!feature) return;
        const zoom = await this.map.getSource('places').getClusterExpansionZoom(feature.properties.cluster_id);
        this.map.easeTo({ center: feature.geometry.coordinates, zoom: zoom + 0.5 });
    },

    // ---- Photos in view ----

    _updateInView() {
        if (!this.map || !this.markers) return;
        const bounds = this.map.getBounds();
        const w = bounds.getWest();
        const e = bounds.getEast();
        const s = bounds.getSouth();
        const n = bounds.getNorth();
        const wraps = e - w >= 360;
        const { lat, lon } = this.markers;

        const inView = [];
        for (let i = 0; i < lat.length; i += 1) {
            if (lat[i] < s || lat[i] > n) continue;
            if (!wraps && !this._lonInside(lon[i], w, e)) continue;
            inView.push(i);
        }
        this._inView = inView;
        this._shown = 0;
        this.el.grid.replaceChildren();
        this.el.photos.scrollTop = 0;

        const count = inView.length;
        this.el.title.textContent = count
            ? `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'} in this area`
            : 'No photos in this area';
        this._showMore();
    },

    _lonInside(value, west, east) {
        // The view can cross the date line (west > east once normalized).
        const norm = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
        const v = norm(value);
        const a = norm(west);
        const b = norm(east);
        return a <= b ? v >= a && v <= b : v >= a || v <= b;
    },

    _maybeShowMore() {
        const p = this.el.photos;
        if (p.scrollTop + p.clientHeight > p.scrollHeight - 600) this._showMore();
    },

    _showMore() {
        const end = Math.min(this._inView.length, this._shown + this.PAGE);
        const fragment = document.createDocumentFragment();
        for (let k = this._shown; k < end; k += 1) fragment.appendChild(this._tile(k));
        this.el.grid.appendChild(fragment);
        this._shown = end;
    },

    _tile(k) {
        const id = this.markers.ids[this._inView[k]];
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'gallery-item';
        tile.dataset.assetId = id;
        tile.setAttribute('aria-label', 'Open photo');
        const img = document.createElement('img');
        img.src = API.getThumbnailUrl(id, 'thumbnail');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        tile.appendChild(img);
        tile.addEventListener('click', () => this._open(k));
        return tile;
    },

    _item(k) {
        return { id: this.markers.ids[this._inView[k]], partial: true, _k: k };
    },

    _open(k) {
        const item = this._item(k);
        Lightbox.open(item, k, this);
    },

    /** A pin was tapped: open it within the photos in view (or on its own if off-list). */
    _openMarker(index) {
        let k = this._inView.indexOf(index);
        if (k < 0) {
            this._updateInView();
            k = this._inView.indexOf(index);
        }
        if (k >= 0) this._open(k);
    },

    // ---- Lightbox navigation through the photos in view ----

    hasPrevious(item) {
        return item._k > 0;
    },

    hasNext(item) {
        return item._k < this._inView.length - 1;
    },

    async previous(item) {
        return item._k > 0 ? this._item(item._k - 1) : null;
    },

    async next(item) {
        return item._k < this._inView.length - 1 ? this._item(item._k + 1) : null;
    },

    /** After the lightbox closes, show the last photo viewed in the list. */
    reveal(item) {
        if (!item || item._k >= this._inView.length) return;
        while (this._shown <= item._k) this._showMore();
        const tile = this.el.grid.children[item._k];
        tile?.scrollIntoView({ block: 'nearest' });
    },
};

window.Places = Places;
