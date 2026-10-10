/**
 * Full-screen media viewer with metadata sidebar.
 */

const Lightbox = {
    elements: {
        lightbox: null,
        overlay: null,
        close: null,
        prev: null,
        next: null,
        media: null,
        image: null,
        video: null,
        loading: null,
        error: null,
        download: null,
        share: null,
        copy: null,
        downloadOriginal: null,
        infoToggle: null,
        sidebar: null,
        sidebarClose: null,
        sidebarContent: null,
        zoomToggle: null,
    },

    currentAsset: null,
    currentIndex: -1,
    navigator: null,
    _navItem: null,
    _openTicket: 0,
    // Bumps on every displayMedia call so stale video handlers ignore themselves
    mediaGeneration: 0,
    _videoCleanup: null,
    originalImage: null,
    _originalDimensions: null,
    // The exact file on screen (original or Immich preview). Download, share and copy
    // all reuse it, so they're instant and never re-fetch.
    _displayedFile: null,

    // Zoom/pan state for the image view. Scale is clamped to [MIN_ZOOM, maxZoom],
    // where maxZoom (see _getMaxZoom) uses the decoded original so "100%" always means
    // one native image pixel per device pixel — zoom can never go past what the
    // source actually has. x/y are screen-space pixel offsets applied after scaling
    // (translate() runs after scale() in `translate(x,y) scale(s)`, so they stay in
    // unscaled px).
    zoom: { scale: 1, x: 0, y: 0 },
    MIN_ZOOM: 1,
    HARD_MAX_ZOOM: 8, // sanity ceiling for unusually large source/display ratios
    FALLBACK_MAX_ZOOM: 3, // used before layout/source dimensions are known
    EDGE_HANDOFF_PX: 70, // overdrag past the pan limit that hands off to prev/next
    SWIPE_THRESHOLD_PX: 50, // horizontal drag at Fit that counts as swipe-to-navigate
    _isPanning: false,
    _panPointer: null,
    _pinch: null,
    _lastTap: null,
    _swipePointer: null,
    _wheelZoomSnapTimer: null,

    init() {
        this.elements.lightbox = document.getElementById('lightbox');
        this.elements.overlay = document.getElementById('lightbox-overlay');
        this.elements.close = document.getElementById('lightbox-close');
        this.elements.prev = document.getElementById('lightbox-prev');
        this.elements.next = document.getElementById('lightbox-next');
        this.elements.media = document.getElementById('lightbox-media');
        this.elements.image = document.getElementById('lightbox-image');
        this.elements.video = document.getElementById('lightbox-video');
        this.elements.loading = document.getElementById('lightbox-loading');
        this.elements.error = document.getElementById('lightbox-error');
        this.elements.download = document.getElementById('lightbox-download');
        this.elements.share = document.getElementById('lightbox-share');
        this.elements.copy = document.getElementById('lightbox-copy');
        this.elements.downloadOriginal = document.getElementById('meta-download-original');
        this.elements.infoToggle = document.getElementById('lightbox-info-toggle');
        this.elements.sidebar = document.getElementById('lightbox-sidebar');
        this.elements.sidebarClose = document.getElementById('sidebar-close');
        this.elements.sidebarContent = document.getElementById('sidebar-content');
        this.elements.zoomToggle = document.getElementById('lightbox-zoom-toggle');
        this.originalImage = new OriginalImage();

        this.elements.overlay.addEventListener('click', () => this.close());
        this.elements.close.addEventListener('click', () => this.close());
        this.elements.prev.addEventListener('click', () => this.previous());
        this.elements.next.addEventListener('click', () => this.next());
        this.elements.infoToggle.addEventListener('click', () => this.toggleSidebar());
        this.elements.sidebarClose?.addEventListener('click', () => this.toggleSidebar());
        this.elements.download?.addEventListener('click', (e) => {
            e.preventDefault();
            this.downloadDisplayed();
            window.Presence?.logSave('download');
        });
        // Share and copy must start synchronously inside the tap (no await first),
        // or iOS Safari drops the user-gesture permission.
        this.elements.share?.addEventListener('click', (e) => {
            e.preventDefault();
            this.shareDisplayed();
            window.Presence?.logSave('share');
        });
        this.elements.copy?.addEventListener('click', (e) => {
            e.preventDefault();
            this.copyDisplayed();
            window.Presence?.logSave('copy');
        });
        this.elements.downloadOriginal?.addEventListener('click', (e) => {
            e.preventDefault();
            this.downloadAsset();
        });
        this.elements.zoomToggle?.addEventListener('click', () => {
            const rect = this.elements.media.getBoundingClientRect();
            this.toggleZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
        });

        document.addEventListener('keydown', (e) => this.handleKeyboard(e));
        this.elements.lightbox.addEventListener(
            'wheel',
            (e) => {
                // Let the metadata sidebar scroll normally.
                if (
                    this.elements.sidebar &&
                    !this.elements.sidebar.hidden &&
                    this.elements.sidebar.contains(e.target)
                ) {
                    return;
                }
                if (this.elements.image.hidden) return;

                // A trackpad pinch arrives as wheel+ctrlKey (browsers synthesize this);
                // plain two-finger scroll should pan when zoomed, not always zoom.
                if (e.ctrlKey) {
                    e.preventDefault();
                    const factor = Math.exp(-e.deltaY * 0.0015);
                    this._zoomAt(this.zoom.scale * factor, e.clientX, e.clientY);
                    // Wheel events have no discrete "gesture end" — treat a pause as
                    // the end of the pinch and snap if we landed near a stop.
                    clearTimeout(this._wheelZoomSnapTimer);
                    this._wheelZoomSnapTimer = window.setTimeout(
                        () => this._snapZoomToStop(e.clientX, e.clientY),
                        150,
                    );
                    return;
                }

                if (this.zoom.scale <= this.MIN_ZOOM + 0.001) return;
                e.preventDefault();
                this.zoom.x -= e.deltaX;
                this.zoom.y -= e.deltaY;
                this._clampPan();
                this._applyZoomTransform();
            },
            { passive: false },
        );

        this.initZoomGestures();
    },

    /**
     * `navigator` (e.g. Places) supplies previous/next for lists other than the gallery;
     * without one, navigation walks the gallery's State.assets.
     */
    async open(asset, index, navigator = null) {
        this.navigator = navigator;
        this._navItem = asset;
        this.currentAsset = asset;
        this.currentIndex = index;

        State.set({
            lightboxAssetId: asset.id,
            lightboxIndex: index,
        });

        this.elements.lightbox.hidden = false;
        document.body.style.overflow = 'hidden';
        this.showLoading();

        // Entries that carry only an id: get the file details first, so a JPEG opens (and
        // downloads) as the original rather than the smaller preview.
        if (asset.partial) {
            const ticket = ++this._openTicket;
            this.updateNavigation();
            try {
                const detailed = await API.getAsset(asset.id);
                if (ticket !== this._openTicket || this.elements.lightbox.hidden) return;
                asset = detailed;
                this.currentAsset = detailed;
            } catch (error) {
                if (ticket !== this._openTicket || this.elements.lightbox.hidden) return;
                console.error('Failed to load asset details:', error);
            }
        }

        const generation = this.displayMedia(asset);
        this.updateDownloadLink(asset);
        this.updateNavigation();
        this.updateMetadata(asset);

        if (!asset.exifInfo) {
            try {
                const detailedAsset = await API.getAsset(asset.id);
                if (
                    generation !== this.mediaGeneration ||
                    this.currentAsset?.id !== asset.id
                ) {
                    return;
                }
                this.currentAsset = detailedAsset;
                this.updateDownloadLink(detailedAsset);
                this.updateNavigation();
                this.updateMetadata(detailedAsset);
            } catch (error) {
                if (
                    generation === this.mediaGeneration &&
                    this.currentAsset?.id === asset.id
                ) {
                    console.error('Failed to load asset details:', error);
                }
            }
        }
    },

    close() {
        this.mediaGeneration++;
        this._openTicket++;
        const navigator = this.navigator;
        const lastItem = this._navItem;
        this.navigator = null;
        this._navItem = null;
        this.elements.lightbox.hidden = true;
        // A page underneath (Places) keeps the body locked while it's open.
        document.body.style.overflow = window.Places?.isOpen ? 'hidden' : '';

        this.resetImage();
        this.resetVideo();
        this.resetZoom();
        this.currentAsset = null;
        this.currentIndex = -1;

        State.set({
            lightboxAssetId: null,
            lightboxIndex: -1,
        });

        navigator?.reveal?.(lastItem);
    },

    /** Stop playback, drop sources, and detach video listeners. */
    resetVideo() {
        if (typeof this._videoCleanup === 'function') {
            this._videoCleanup();
            this._videoCleanup = null;
        }

        const video = this.elements.video;
        video.pause();
        video.removeAttribute('src');
        video.innerHTML = '';
        video.removeAttribute('poster');
        delete video.dataset.src;
        delete video.dataset.loaded;
        video.load();
        video.hidden = true;
        video.onerror = null;
    },

    /** Abort original work, release its blob URL, and remove displayed pixels. */
    resetImage() {
        const image = this.elements.image;
        image.hidden = true;
        image.removeAttribute('src');
        image.onload = null;
        image.onerror = null;
        image.style.width = '';
        image.style.height = '';

        this.originalImage?.clear();
        this._originalDimensions = null;
        this._displayedFile = null;
        this._updateActionState();

        if (this.elements.error) {
            this.elements.error.hidden = true;
        }
    },

    async _step(direction) {
        const navigator = this.navigator;
        const item = this._navItem;
        if (!item) return;
        const can = direction < 0 ? navigator.hasPrevious(item) : navigator.hasNext(item);
        if (!can) return;
        const target = await (direction < 0 ? navigator.previous(item) : navigator.next(item));
        if (target && navigator === this.navigator) await this.open(target, target._k ?? -1, navigator);
    },

    /** Where the open photo sits in the list now (newer photos may have been prepended). */
    _indexNow() {
        const id = this.currentAsset?.id;
        const index = id ? State.getProperty('assets').findIndex((a) => a.id === id) : -1;
        return index >= 0 ? index : this.currentIndex;
    },

    async previous() {
        if (this.navigator) return this._step(-1);
        if (this.currentIndex < 0) return;
        let index = this._indexNow();
        if (index <= 0) {
            // At the top of a list that started at a scrubber jump: fetch the newer photos.
            if (!State.getProperty('hasNewer')) return;
            const id = this.currentAsset?.id;
            await Gallery.loadNewer();
            if (this.currentAsset?.id !== id) return;
            index = this._indexNow();
            if (index <= 0) return;
        }
        const prevAsset = State.getProperty('assets')[index - 1];
        if (prevAsset) {
            await this.open(prevAsset, index - 1);
        }
    },

    async next() {
        if (this.navigator) return this._step(1);
        if (this.currentIndex < 0) return;
        let assets = State.getProperty('assets');
        let index = this._indexNow();

        if (index >= assets.length - 1) {
            if (!State.getProperty('hasMore')) return;
            await Gallery.loadMore();
            assets = State.getProperty('assets');
            index = this._indexNow();
        }

        const nextAsset = assets[index + 1];
        if (nextAsset) {
            await this.open(nextAsset, index + 1);
            return;
        }
        this.updateNavigation();
    },

    displayMedia(asset) {
        const generation = ++this.mediaGeneration;
        const isVideo = asset.type === 'VIDEO';

        // Always tear down any prior video so controls never leak onto photos
        this.resetVideo();
        this.resetImage();
        this.resetZoom();
        if (this.elements.zoomToggle) this.elements.zoomToggle.hidden = isVideo;

        if (isVideo) {
            this._displayVideo(asset, generation);
        } else {
            this._displayImage(asset, generation);
        }

        return generation;
    },

    _displayVideo(asset, generation) {
        const video = this.elements.video;
        video.hidden = false;
        video.preload = 'metadata';
        video.poster = API.getThumbnailUrl(asset.id, 'preview');
        video.dataset.src = API.getVideoPlaybackUrl(asset.id);
        video.dataset.loaded = '0';
        this.hideLoading();

        const loadSourceOnce = async () => {
            if (generation !== this.mediaGeneration) return;
            if (video.dataset.loaded === '1') return;
            this.showLoading();

            const source = document.createElement('source');
            source.src = video.dataset.src;
            source.type = 'video/mp4';
            video.appendChild(source);

            video.load();
            video.dataset.loaded = '1';

            const hideLoadingOnReady = () => {
                if (generation !== this.mediaGeneration) return;
                this.hideLoading();
                video.removeEventListener('loadeddata', hideLoadingOnReady);
                video.removeEventListener('canplay', hideLoadingOnReady);
            };
            video.addEventListener('loadeddata', hideLoadingOnReady);
            video.addEventListener('canplay', hideLoadingOnReady);

            try {
                await video.play();
            } catch {
                // Autoplay blocked — user must click play
            } finally {
                if (generation === this.mediaGeneration) this.hideLoading();
            }
        };

        const onUserInitiatedPlay = () => {
            loadSourceOnce();
            video.removeEventListener('click', onUserInitiatedPlay);
            video.removeEventListener('play', onUserInitiatedPlay);
        };

        const onWaiting = () => {
            if (generation === this.mediaGeneration) this.showLoading();
        };
        const onPlaying = () => {
            if (generation === this.mediaGeneration) this.hideLoading();
        };

        video.addEventListener('click', onUserInitiatedPlay);
        video.addEventListener('play', onUserInitiatedPlay);
        video.addEventListener('waiting', onWaiting);
        video.addEventListener('playing', onPlaying);

        video.onerror = () => {
            if (generation !== this.mediaGeneration) return;
            this.hideLoading();
            console.error('Failed to load video');
        };

        this._videoCleanup = () => {
            video.removeEventListener('click', onUserInitiatedPlay);
            video.removeEventListener('play', onUserInitiatedPlay);
            video.removeEventListener('waiting', onWaiting);
            video.removeEventListener('playing', onPlaying);
        };
    },

    /** True when browsers can decode the original file directly. RAW (ARW, NEF, CR2,
     *  DNG...), HEIC and TIFF are not, so those show Immich's JPEG preview instead. */
    _isWebDisplayable(asset) {
        const mime = (asset.originalMimeType || '').toLowerCase();
        if (mime) return /^image\/(jpeg|png|gif|webp|avif)$/.test(mime);
        const ext = (asset.originalFileName || '').split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext);
    },

    _displayImage(asset, generation, forcePreview = false) {
        const img = this.elements.image;
        img.alt = asset.originalFileName || 'Photo';
        this.showLoading();

        const usePreview = forcePreview || !this._isWebDisplayable(asset);
        const src = usePreview
            ? API.getThumbnailUrl(asset.id, 'preview')
            : API.getOriginalUrl(asset.id);

        this.originalImage
            .load(src)
            .then(async (decoded) => {
                if (
                    generation !== this.mediaGeneration ||
                    this.currentAsset?.id !== asset.id
                ) {
                    return;
                }

                img.src = decoded.url;
                try {
                    await img.decode();
                } catch (error) {
                    if (
                        generation === this.mediaGeneration &&
                        this.currentAsset?.id === asset.id
                    ) {
                        img.hidden = true;
                        img.removeAttribute('src');
                        this.originalImage.clear();
                    }
                    throw error;
                }

                if (
                    generation !== this.mediaGeneration ||
                    this.currentAsset?.id !== asset.id
                ) {
                    return;
                }

                this._originalDimensions = {
                    width: decoded.naturalWidth,
                    height: decoded.naturalHeight,
                };
                this._displayedFile = this._makeFile(asset, decoded.blob, usePreview);
                this._updateActionState();
                img.hidden = false;
                this.hideLoading();
                this._updateZoomChip();
            })
            .catch((error) => {
                if (
                    error?.name === 'AbortError' ||
                    generation !== this.mediaGeneration ||
                    this.currentAsset?.id !== asset.id
                ) {
                    return;
                }

                if (!usePreview) {
                    this._displayImage(asset, generation, true);
                    return;
                }

                this.hideLoading();
                if (this.elements.error) {
                    this.elements.error.textContent =
                        'This photo could not be displayed. You can still download it.';
                    this.elements.error.hidden = false;
                }
                console.error('Failed to display original photo:', error);
            });
    },

    // ----- Zoom & pan -----

    /** Zoom to `newScale`, keeping the content under (clientX, clientY) fixed on screen. */
    _zoomAt(newScale, clientX, clientY) {
        if (this.elements.image.hidden) return;

        newScale = Math.min(this._getMaxZoom(), Math.max(this.MIN_ZOOM, newScale));

        if (newScale <= this.MIN_ZOOM + 0.001) {
            this.zoom = { scale: 1, x: 0, y: 0 };
        } else {
            const rect = this.elements.media.getBoundingClientRect();
            const cx = clientX - (rect.left + rect.width / 2);
            const cy = clientY - (rect.top + rect.height / 2);
            const ratio = newScale / this.zoom.scale;

            this.zoom.x = cx - (cx - this.zoom.x) * ratio;
            this.zoom.y = cy - (cy - this.zoom.y) * ratio;
            this.zoom.scale = newScale;
            this._clampPan();
        }

        this._applyZoomTransform();
    },

    /** Native (1:1 device-pixel) zoom ceiling for the current asset — "100%" always
     *  means one source pixel per device pixel, never magnified past the decoded
     *  original. Recomputed live from current layout and source dimensions. */
    _getMaxZoom() {
        const img = this.elements.image;
        const displayedWidth = img.offsetWidth;
        if (!displayedWidth) return this.FALLBACK_MAX_ZOOM;

        const nativeWidth = this._originalDimensions?.width;

        if (!nativeWidth) return this.FALLBACK_MAX_ZOOM;

        const dpr = window.devicePixelRatio || 1;
        const scale = nativeWidth / dpr / displayedWidth;
        return Math.max(this.MIN_ZOOM, Math.min(scale, this.HARD_MAX_ZOOM));
    },

    /** False when the asset is already displayed at/above native resolution — no
     *  point offering zoom (and it would otherwise magnify beyond the original). */
    _zoomAvailable() {
        return this._getMaxZoom() > this.MIN_ZOOM + 0.02;
    },

    /** How far the image can pan before its edge would show empty space. */
    _panLimits() {
        const img = this.elements.image;
        const media = this.elements.media;
        return {
            maxX: Math.max(0, (img.offsetWidth * this.zoom.scale - media.clientWidth) / 2),
            maxY: Math.max(0, (img.offsetHeight * this.zoom.scale - media.clientHeight) / 2),
        };
    },

    /** Keep the zoomed image from panning past its edges. With `rubberBand`, allow a
     *  resisted overdrag instead of a hard stop — used while a touch drag is live so
     *  the edge feels soft instead of a wall. */
    _clampPan({ rubberBand = false } = {}) {
        const { maxX, maxY } = this._panLimits();
        if (rubberBand) {
            this.zoom.x = this._rubberBand(this.zoom.x, maxX);
            this.zoom.y = this._rubberBand(this.zoom.y, maxY);
        } else {
            this.zoom.x = Math.min(maxX, Math.max(-maxX, this.zoom.x));
            this.zoom.y = Math.min(maxY, Math.max(-maxY, this.zoom.y));
        }
    },

    _rubberBand(value, max) {
        if (value > max) return max + (value - max) * 0.35;
        if (value < -max) return -max - (-value - max) * 0.35;
        return value;
    },

    /** Animate the pan back within bounds after a released overdrag that didn't
     *  clear the edge-handoff threshold. */
    _springBackPan() {
        this.elements.image.classList.add('zoom-transition');
        this._clampPan();
        this._applyZoomTransform();
        window.setTimeout(() => this.elements.image.classList.remove('zoom-transition'), 220);
    },

    /** After a continuous zoom gesture (pinch, trackpad pinch) ends near a stop
     *  (within 15% of the Fit/100% range), snap to it — keeps the two named stops
     *  the primary interaction model while leaving the gesture itself continuous. */
    _snapZoomToStop(clientX, clientY) {
        const maxZoom = this._getMaxZoom();
        const distToMin = Math.abs(this.zoom.scale - this.MIN_ZOOM);
        const distToMax = Math.abs(this.zoom.scale - maxZoom);
        const nearest = distToMin < distToMax ? this.MIN_ZOOM : maxZoom;
        const threshold = (maxZoom - this.MIN_ZOOM) * 0.15;

        if (Math.min(distToMin, distToMax) > threshold) return;

        this.elements.image.classList.add('zoom-transition');
        this._zoomAt(nearest, clientX, clientY);
        window.setTimeout(() => this.elements.image.classList.remove('zoom-transition'), 220);
    },

    _applyZoomTransform() {
        const { scale, x, y } = this.zoom;
        this.elements.image.style.transform =
            scale > 1.001 ? `translate(${x}px, ${y}px) scale(${scale})` : '';

        this.elements.image.classList.toggle('zoomed', scale > 1.001);
        this._updateZoomChip();
    },

    /** Sync the toolbar zoom chip's label ("Fit" / live % while dragging / "100%")
     *  and visibility with current zoom state. */
    _updateZoomChip() {
        const btn = this.elements.zoomToggle;
        if (!btn) return;

        btn.hidden = this.elements.image.hidden || !this._zoomAvailable();

        const zoomed = this.zoom.scale > this.MIN_ZOOM + 0.001;
        btn.classList.toggle('active', zoomed);
        btn.setAttribute('aria-label', zoomed ? 'Reset zoom' : 'Zoom to 100%');

        const label = btn.querySelector('.zoom-chip-label');
        if (label) {
            const text = zoomed ? `${Math.round((this.zoom.scale / this._getMaxZoom()) * 100)}%` : 'Fit';
            label.textContent = text;
        }
    },

    resetZoom() {
        clearTimeout(this._wheelZoomSnapTimer);
        this.zoom = { scale: 1, x: 0, y: 0 };
        this._isPanning = false;
        this._pinch = null;
        this._swipePointer = null;
        this._lastTap = null;
        this.elements.image.classList.remove('panning');
        this._applyZoomTransform();
    },

    /** Toggle between Fit and native 100%, centered on (clientX, clientY). */
    toggleZoomAt(clientX, clientY) {
        if (this.zoom.scale <= 1.001 && !this._zoomAvailable()) return;

        const img = this.elements.image;
        img.classList.add('zoom-transition');
        window.setTimeout(() => img.classList.remove('zoom-transition'), 220);

        if (this.zoom.scale > 1.001) {
            this.resetZoom();
        } else {
            this._zoomAt(this._getMaxZoom(), clientX, clientY);
        }
    },

    /** Zoom in/out around the media's center, for keyboard shortcuts. */
    _keyboardZoom(factor) {
        if (this.elements.image.hidden) return;
        const rect = this.elements.media.getBoundingClientRect();
        this._zoomAt(this.zoom.scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },

    initZoomGestures() {
        const img = this.elements.image;

        img.addEventListener('dblclick', (e) => {
            e.preventDefault();
            this.toggleZoomAt(e.clientX, e.clientY);
        });

        // Mouse drag-to-pan while zoomed in.
        img.addEventListener('mousedown', (e) => {
            if (this.zoom.scale <= 1.001) return;
            e.preventDefault();
            this._isPanning = true;
            this._panPointer = { startX: e.clientX, startY: e.clientY, originX: this.zoom.x, originY: this.zoom.y };
            img.classList.add('panning');
        });
        window.addEventListener('mousemove', (e) => {
            if (!this._isPanning || !this._panPointer) return;
            this.zoom.x = this._panPointer.originX + (e.clientX - this._panPointer.startX);
            this.zoom.y = this._panPointer.originY + (e.clientY - this._panPointer.startY);
            this._clampPan();
            this._applyZoomTransform();
        });
        window.addEventListener('mouseup', () => {
            if (!this._isPanning) return;
            this._isPanning = false;
            img.classList.remove('panning');
        });

        // Touch: pinch-to-zoom (snaps to Fit/100% near release), single-finger pan
        // while zoomed (rubber-bands at the edge and hands off to prev/next on a
        // sustained overdrag), swipe-to-navigate at Fit, and double-tap to toggle.
        img.addEventListener(
            'touchstart',
            (e) => {
                if (e.touches.length === 2) {
                    const [t1, t2] = e.touches;
                    this._pinch = {
                        startDist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
                        startScale: this.zoom.scale,
                        lastX: (t1.clientX + t2.clientX) / 2,
                        lastY: (t1.clientY + t2.clientY) / 2,
                    };
                    this._isPanning = false;
                    this._swipePointer = null;
                    return;
                }

                if (e.touches.length !== 1) return;
                const t = e.touches[0];

                const now = Date.now();
                if (
                    this._lastTap &&
                    now - this._lastTap.time < 300 &&
                    Math.hypot(t.clientX - this._lastTap.x, t.clientY - this._lastTap.y) < 30
                ) {
                    this.toggleZoomAt(t.clientX, t.clientY);
                    this._lastTap = null;
                    return;
                }
                this._lastTap = { time: now, x: t.clientX, y: t.clientY };

                if (this.zoom.scale > 1.001) {
                    this._isPanning = true;
                    this._panPointer = {
                        startX: t.clientX,
                        startY: t.clientY,
                        originX: this.zoom.x,
                        originY: this.zoom.y,
                        overdragDir: 0,
                        overdragAmount: 0,
                    };
                } else {
                    this._swipePointer = { startX: t.clientX, startY: t.clientY };
                }
            },
            { passive: true },
        );

        img.addEventListener(
            'touchmove',
            (e) => {
                if (e.touches.length === 2 && this._pinch) {
                    e.preventDefault();
                    const [t1, t2] = e.touches;
                    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
                    const midX = (t1.clientX + t2.clientX) / 2;
                    const midY = (t1.clientY + t2.clientY) / 2;
                    this._pinch.lastX = midX;
                    this._pinch.lastY = midY;
                    this._zoomAt(this._pinch.startScale * (dist / this._pinch.startDist), midX, midY);
                    return;
                }

                if (e.touches.length === 1 && this._isPanning && this._panPointer) {
                    e.preventDefault();
                    const t = e.touches[0];
                    const rawX = this._panPointer.originX + (t.clientX - this._panPointer.startX);
                    const rawY = this._panPointer.originY + (t.clientY - this._panPointer.startY);
                    const { maxX } = this._panLimits();

                    // Track how far past the hard limit the finger has dragged, in the
                    // outward direction, so touchend can decide whether to hand off to
                    // prev/next instead of just springing back.
                    this._panPointer.overdragAmount = Math.max(0, Math.abs(rawX) - maxX);
                    this._panPointer.overdragDir =
                        this._panPointer.overdragAmount > 0 ? Math.sign(rawX) : 0;

                    this.zoom.x = rawX;
                    this.zoom.y = rawY;
                    this._clampPan({ rubberBand: true });
                    this._applyZoomTransform();
                    return;
                }

                if (e.touches.length === 1 && this._swipePointer) {
                    const t = e.touches[0];
                    const dx = t.clientX - this._swipePointer.startX;
                    const dy = t.clientY - this._swipePointer.startY;
                    if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
                }
            },
            { passive: false },
        );

        img.addEventListener('touchend', (e) => {
            if (e.touches.length < 2 && this._pinch) {
                const { lastX, lastY } = this._pinch;
                this._pinch = null;
                this._snapZoomToStop(lastX, lastY);
            }
            if (e.touches.length > 0) return;

            if (this._isPanning && this._panPointer) {
                const { overdragDir, overdragAmount } = this._panPointer;
                this._isPanning = false;
                // Positive x clamp = image's left edge is fully visible = "beginning";
                // dragging further right past that hands off to the previous photo.
                // Symmetric on the other edge/direction for next.
                if (overdragAmount > this.EDGE_HANDOFF_PX) {
                    if (overdragDir > 0) this.previous();
                    else this.next();
                } else {
                    this._springBackPan();
                }
            }

            if (this._swipePointer) {
                const t = e.changedTouches[0];
                const dx = t.clientX - this._swipePointer.startX;
                const dy = t.clientY - this._swipePointer.startY;
                this._swipePointer = null;
                if (Math.abs(dx) > this.SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
                    if (dx > 0) this.previous();
                    else this.next();
                }
            }
        });
    },

    toggleSidebar() {
        this.elements.sidebar.hidden = !this.elements.sidebar.hidden;
    },

    updateNavigation() {
        if (this.navigator && this._navItem) {
            this.elements.prev.disabled = !this.navigator.hasPrevious(this._navItem);
            this.elements.next.disabled = !this.navigator.hasNext(this._navItem);
            this.elements.prev.style.opacity = this.elements.prev.disabled ? '0.3' : '1';
            this.elements.next.style.opacity = this.elements.next.disabled ? '0.3' : '1';
            return;
        }
        const assets = State.getProperty('assets');
        const detached = this.currentIndex < 0;
        const index = this._indexNow();

        this.elements.prev.disabled = detached || (index <= 0 && !State.getProperty('hasNewer'));
        this.elements.prev.style.opacity = this.elements.prev.disabled ? '0.3' : '1';

        this.elements.next.disabled =
            detached || (index >= assets.length - 1 && !State.getProperty('hasMore'));
        this.elements.next.style.opacity = this.elements.next.disabled ? '0.3' : '1';
    },

    updateMetadata(asset) {
        const datetime = asset.localDateTime || asset.fileCreatedAt;
        document.getElementById('meta-datetime').textContent = datetime
            ? new Date(datetime).toLocaleString(undefined, { timeZone: 'UTC' }) // wall-clock time
            : '-';

        const exif = asset.exifInfo || {};
        const camera = [exif.make, exif.model].filter(Boolean).join(' ');
        document.getElementById('meta-camera').textContent = camera || '-';
        document.getElementById('meta-lens').textContent = exif.lensModel || '-';

        document.getElementById('meta-focal').textContent = exif.focalLength
            ? `${exif.focalLength}mm`
            : '-';
        document.getElementById('meta-aperture').textContent = exif.fNumber
            ? `f/${exif.fNumber}`
            : '-';
        document.getElementById('meta-shutter').textContent = exif.exposureTime
            ? this.formatShutterSpeed(exif.exposureTime)
            : '-';
        document.getElementById('meta-iso').textContent = exif.iso || '-';

        const locationSection = document.getElementById('meta-location-section');
        const location = [exif.city, exif.state, exif.country].filter(Boolean).join(', ');
        if (location) {
            document.getElementById('meta-location').textContent = location;
            locationSection.hidden = false;
        } else {
            locationSection.hidden = true;
        }

        const peopleSection = document.getElementById('meta-people-section');
        const peopleContainer = document.getElementById('meta-people');
        peopleContainer.innerHTML = '';

        if (asset.people && asset.people.length > 0) {
            asset.people.forEach((person) => {
                const chip = document.createElement('span');
                chip.className = 'person-chip';

                const img = document.createElement('img');
                img.src = API.getPersonThumbnailUrl(person.id);
                img.alt = person.name || '';
                chip.appendChild(img);

                const nameSpan = document.createElement('span');
                nameSpan.textContent = person.name || '';
                chip.appendChild(nameSpan);

                chip.addEventListener('click', () => {
                    this.close();
                    const currentPersonIds = State.getProperty('personIds');
                    if (!currentPersonIds.includes(person.id)) {
                        State.set({
                            personIds: [...currentPersonIds, person.id],
                            page: 1,
                            assets: [],
                        });
                        Filters.updatePeopleChips([...currentPersonIds, person.id]);
                        Filters.showPanel();
                        Gallery.load();
                    }
                });
                peopleContainer.appendChild(chip);
            });
            peopleSection.hidden = false;
        } else {
            peopleSection.hidden = true;
        }

        document.getElementById('meta-filename').textContent = asset.originalFileName || '-';

        const dimensions =
            asset.exifInfo?.exifImageWidth && asset.exifInfo?.exifImageHeight
                ? `${asset.exifInfo.exifImageWidth} × ${asset.exifInfo.exifImageHeight}`
                : '-';
        document.getElementById('meta-dimensions').textContent = dimensions;

        document.getElementById('meta-filesize').textContent = asset.exifInfo?.fileSizeInByte
            ? this.formatFileSize(asset.exifInfo.fileSizeInByte)
            : '-';
    },

    formatShutterSpeed(seconds) {
        let value = seconds;

        if (typeof seconds === 'string') {
            if (seconds.includes('/')) {
                const [num, den] = seconds.split('/').map(parseFloat);
                if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
                    value = num / den;
                }
            } else {
                const parsed = parseFloat(seconds);
                if (Number.isFinite(parsed)) {
                    value = parsed;
                }
            }
        }

        if (!Number.isFinite(value) || value <= 0) {
            return '-';
        }

        if (value >= 1) {
            const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
            return `${rounded}s`;
        }
        return `1/${Math.round(1 / value)}s`;
    },

    formatFileSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    },

    updateDownloadLink(asset) {
        const isVideo = asset.type === 'VIDEO';
        const { share, copy, downloadOriginal } = this.elements;
        const canShare = this._canShareFiles();

        if (this.elements.download) {
            // On phones the share sheet's "Save Image" puts the photo in Photos, which
            // beats Download (Files app). So touch + share-capable gets Share only.
            this.elements.download.hidden = isVideo || (canShare && this._isTouchDevice());
            this.elements.download.dataset.assetId = asset.id;
            this.elements.download.dataset.fileName = asset.originalFileName || 'asset';
        }
        if (share) share.hidden = isVideo || !canShare;
        if (copy) copy.hidden = isVideo || !this._canCopyImage();

        // RAW/HEIC originals are offered separately; JPEG/PNG originals are already
        // what the main Download button gives.
        if (downloadOriginal) {
            const showOriginal = !isVideo && !this._isWebDisplayable(asset);
            downloadOriginal.hidden = !showOriginal;
            if (showOriginal) {
                const ext = (asset.originalFileName || '').split('.').pop().toUpperCase();
                const bytes = asset.exifInfo?.fileSizeInByte;
                const size = bytes ? ` · ${this.formatFileSize(bytes)}` : '';
                downloadOriginal.textContent = `Download original (${ext}${size})`;
            }
        }
        this._updateActionState();
    },

    /** Download/share/copy stay disabled until the photo's bytes are on screen. */
    _updateActionState() {
        const ready = Boolean(this._displayedFile);
        for (const el of [this.elements.download, this.elements.share, this.elements.copy]) {
            if (el) el.disabled = !ready;
        }
    },

    _makeFile(asset, blob, usedPreview) {
        try {
            const type = blob?.type || 'image/jpeg';
            const ext = {
                'image/jpeg': 'jpg',
                'image/png': 'png',
                'image/webp': 'webp',
                'image/gif': 'gif',
                'image/avif': 'avif',
            }[type] || 'jpg';
            const original = asset.originalFileName || 'photo';
            const name = usedPreview ? `${original.replace(/\.[^.]+$/, '')}.${ext}` : original;
            return new File([blob], name, { type });
        } catch {
            return null;
        }
    },

    _canShareFiles() {
        try {
            const nav = globalThis.navigator;
            if (!nav?.canShare || typeof File === 'undefined') return false;
            return nav.canShare({ files: [new File([''], 'test.jpg', { type: 'image/jpeg' })] });
        } catch {
            return false;
        }
    },

    _isTouchDevice() {
        try {
            return Boolean(window.matchMedia?.('(pointer: coarse)').matches);
        } catch {
            return false;
        }
    },

    _canCopyImage() {
        return Boolean(
            globalThis.isSecureContext &&
                globalThis.navigator?.clipboard?.write &&
                typeof globalThis.ClipboardItem !== 'undefined',
        );
    },

    /** Brief confirmation on a toolbar button (reuses the "active" pill style). */
    _flash(button, label) {
        if (!button) return;
        const previous = button.getAttribute('aria-label');
        button.classList.add('active');
        button.setAttribute('aria-label', label);
        button.title = label;
        window.setTimeout(() => {
            button.classList.remove('active');
            button.setAttribute('aria-label', previous);
            button.title = '';
        }, 1400);
    },

    /** Save the photo exactly as shown (JPEG for RAW/HEIC, the original otherwise). */
    downloadDisplayed() {
        const file = this._displayedFile;
        if (!file) return;
        const url = window.URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    },

    shareDisplayed() {
        const file = this._displayedFile;
        if (!file) return;
        globalThis.navigator.share({ files: [file] }).catch((error) => {
            if (error?.name !== 'AbortError') {
                console.error('Share failed:', error);
                this._flash(this.elements.share, 'Share failed');
            }
        });
    },

    copyDisplayed() {
        const file = this._displayedFile;
        if (!file) return;
        // Clipboards only reliably accept PNG. Hand ClipboardItem a promise so the
        // write starts inside the tap even though the conversion is async.
        const png = file.type === 'image/png' ? Promise.resolve(file) : this._toPng(file);
        globalThis.navigator.clipboard
            .write([new ClipboardItem({ 'image/png': png })])
            .then(() => this._flash(this.elements.copy, 'Copied'))
            .catch((error) => {
                console.error('Copy failed:', error);
                this._flash(this.elements.copy, 'Copy failed');
            });
    },

    /** Re-encode as PNG, capped at 4096px on the long edge so huge originals stay fast. */
    async _toPng(blob) {
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        return new Promise((resolve, reject) => {
            canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('PNG encode failed'))), 'image/png');
        });
    },

    async downloadAsset() {
        if (!this.currentAsset) return;

        try {
            const response = await fetch(API.getDownloadUrl(this.currentAsset.id));
            if (!response.ok) {
                throw new Error(`Download failed: ${response.statusText}`);
            }

            const blob = await response.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = this.currentAsset.originalFileName || 'asset';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(blobUrl);
        } catch (error) {
            console.error('Failed to download asset:', error);
            alert('Download failed. Please try again.');
        }
    },

    handleKeyboard(e) {
        if (this.elements.lightbox.hidden) return;

        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) {
            if (e.key === 'Escape') {
                this.close();
            }
            return;
        }

        switch (e.key) {
            case 'Escape':
                this.close();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.previous();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.next();
                break;
            case 'i':
                this.toggleSidebar();
                break;
            case '+':
            case '=':
                e.preventDefault();
                this._keyboardZoom(1.3);
                break;
            case '-':
            case '_':
                e.preventDefault();
                this._keyboardZoom(1 / 1.3);
                break;
            case '0':
                e.preventDefault();
                this.resetZoom();
                break;
        }
    },

    showLoading() {
        this.elements.loading.hidden = false;
    },

    hideLoading() {
        this.elements.loading.hidden = true;
    },
};

window.Lightbox = Lightbox;
