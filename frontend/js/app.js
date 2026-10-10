/**
 * Bootstraps theme, density, gallery, lightbox, filters, people, and the scrubber.
 */

const App = {
    VIEW_MODES: {
        dense: 'Dense',
        comfortable: 'Comfortable',
        large: 'Large',
    },
    DEFAULT_VIEW: 'large',

    async init() {
        this.initTheme();
        this.initViewMode();
        this.initHeaderAutoHide();

        Gallery.init();
        Lightbox.init();
        Filters.init();
        People.init();
        Places.init();
        Scrubber.init();

        State.loadFromURL();
        await this.checkHealth();
        await Gallery.load();
    },

    /** Thumbnail density: dense | comfortable | large. Desktop has a button per size;
     *  phones get one button that cycles, plus pinching the grid. */
    SIZE_ORDER: ['dense', 'comfortable', 'large'], // small → big

    initViewMode() {
        const buttons = [...document.querySelectorAll('.view-btn')];
        let saved = null;
        try {
            saved = localStorage.getItem('viewMode');
        } catch {
            /* private mode */
        }
        this.setViewMode(this.VIEW_MODES[saved] ? saved : this.DEFAULT_VIEW, { initial: true });

        buttons.forEach((btn) => {
            btn.addEventListener('click', () => this.setViewMode(btn.dataset.view));
        });
        document.getElementById('view-cycle')?.addEventListener('click', () => {
            // Large → comfortable → dense → large
            const order = this.SIZE_ORDER;
            const index = order.indexOf(document.documentElement.dataset.view);
            this.setViewMode(order[(index - 1 + order.length) % order.length]);
        });
        this.initPinchToResize();
    },

    /** Change size, keeping the photo at `anchorY` (or the top one) where it was. */
    setViewMode(mode, { initial = false, anchorY = null } = {}) {
        const root = document.documentElement;
        const next = this.VIEW_MODES[mode] ? mode : this.DEFAULT_VIEW;
        const previous = root.dataset.view;
        const anchor = initial ? null : Gallery.captureAnchor(anchorY);

        root.dataset.view = next;
        document.querySelectorAll('.view-btn').forEach((btn) => {
            btn.setAttribute('aria-pressed', String(btn.dataset.view === next));
        });
        const cycle = document.getElementById('view-cycle');
        if (cycle) cycle.setAttribute('aria-label', `Thumbnail size: ${this.VIEW_MODES[next]}. Tap to change`);
        try {
            localStorage.setItem('viewMode', next);
        } catch {
            /* private mode */
        }

        if (!initial && previous !== next) {
            Gallery.onViewModeChange(next, previous);
            Gallery.restoreAnchor(anchor);
        }
    },

    /** Two-finger pinch on the grid steps through sizes (out = bigger, in = smaller). */
    initPinchToResize() {
        const area = document.querySelector('.main-content');
        if (!area) return;
        let pinch = null;

        const spread = (touches) =>
            Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

        area.addEventListener(
            'touchstart',
            (e) => {
                if (e.touches.length === 2) pinch = { distance: spread(e.touches) };
            },
            { passive: true }
        );
        area.addEventListener(
            'touchmove',
            (e) => {
                if (!pinch || e.touches.length !== 2) return;
                e.preventDefault(); // no page zoom while resizing the grid
                const ratio = spread(e.touches) / (pinch.distance || 1);
                if (ratio < 1.3 && ratio > 0.77) return;

                const order = this.SIZE_ORDER;
                const index = order.indexOf(document.documentElement.dataset.view);
                const target = order[Math.min(Math.max(index + (ratio > 1 ? 1 : -1), 0), order.length - 1)];
                pinch.distance = spread(e.touches); // keep pinching to step again
                if (target === order[index]) return;
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                this.setViewMode(target, { anchorY: midY });
            },
            { passive: false }
        );
        const end = (e) => {
            if (e.touches.length < 2) pinch = null;
        };
        area.addEventListener('touchend', end, { passive: true });
        area.addEventListener('touchcancel', end, { passive: true });
        // Safari's own pinch-zoom gesture
        area.addEventListener('gesturestart', (e) => e.preventDefault());
    },

    /** Light/dark follows the device setting. */
    initTheme() {
        const root = document.documentElement;
        const query = window.matchMedia('(prefers-color-scheme: dark)');
        const apply = () => root.classList.toggle('dark', query.matches);
        apply();
        query.addEventListener('change', apply);
        try {
            localStorage.removeItem('theme'); // from the old manual toggle
        } catch {
            /* private mode */
        }
    },

    /** Phones: the header slides away while scrolling down and returns on the way up. */
    initHeaderAutoHide() {
        const header = document.querySelector('.header');
        if (!header) return;
        const phone = window.matchMedia('(max-width: 720px)');
        const search = document.getElementById('search-input');
        let lastY = window.scrollY;

        window.addEventListener(
            'scroll',
            () => {
                const y = window.scrollY;
                const dy = y - lastY;
                if (Math.abs(dy) < 6) return;
                lastY = y;
                const keep =
                    !phone.matches ||
                    y < header.offsetHeight ||
                    dy < 0 ||
                    document.activeElement === search ||
                    window.People?.isOpen ||
                    window.Places?.isOpen;
                header.classList.toggle('header-hidden', !keep);
            },
            { passive: true }
        );
        phone.addEventListener('change', () => header.classList.remove('header-hidden'));
    },

    async checkHealth() {
        try {
            const health = await API.getHealth();
            if (health.immich !== 'connected') {
                console.warn('Immich connection issue:', health.immich);
            }
        } catch (error) {
            console.error('Backend health check failed:', error);
        }
    },
};

document.addEventListener('DOMContentLoaded', () => {
    App.init().catch((error) => {
        console.error('Failed to initialize application:', error);
    });
});

window.App = App;
