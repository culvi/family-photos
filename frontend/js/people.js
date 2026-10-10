/**
 * People page: a browsable grid of everyone named in Immich. Tap a face to see their photos.
 *
 * Reuses the people list Filters already loads, and Filters.showPerson for the actual
 * filtering, so search chips, the filter badge and shareable URLs all stay in sync.
 */

const People = {
    elements: {
        toggle: null,
        page: null,
        close: null,
        search: null,
        grid: null,
        empty: null,
        count: null,
    },

    isOpen: false,
    // Opening pushes a history entry so a phone's back gesture closes the page instead of
    // leaving the site. Work that should happen after closing waits for that pop to land,
    // otherwise the gallery's URL update would be written to the entry we're about to drop.
    _pushedHistory: false,
    _afterClose: null,

    init() {
        this.elements.toggle = document.getElementById('people-toggle');
        this.elements.page = document.getElementById('people-page');
        this.elements.close = document.getElementById('people-close');
        this.elements.search = document.getElementById('people-page-search');
        this.elements.grid = document.getElementById('people-grid');
        this.elements.empty = document.getElementById('people-empty');
        this.elements.count = document.getElementById('people-count');
        if (!this.elements.page) return;

        this.elements.toggle?.addEventListener('click', () => this.open());
        this.elements.close?.addEventListener('click', () => this.close());
        this.elements.search?.addEventListener('input', () => this.render());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });
        window.addEventListener('popstate', () => {
            if (this.isOpen) this.hide();
        });
    },

    async open() {
        if (this.isOpen) return;
        this.isOpen = true;
        this.elements.page.hidden = false;
        document.body.style.overflow = 'hidden';
        this.elements.toggle?.setAttribute('aria-expanded', 'true');

        window.history.pushState({ peoplePage: true }, '');
        this._pushedHistory = true;

        if (this.elements.search) this.elements.search.value = '';
        this.render();

        if (!Filters.peopleList.length) {
            await Filters.loadPeople();
            if (this.isOpen) this.render();
        }

        // Only autofocus with a real pointer; on phones it would pop the keyboard over the faces.
        if (window.matchMedia?.('(hover: hover)').matches) {
            this.elements.search?.focus();
        }
    },

    /** Close via history when we pushed an entry, so back/forward stay consistent. */
    close() {
        if (!this.isOpen) return;
        if (this._pushedHistory) {
            window.history.back(); // popstate → hide()
        } else {
            this.hide();
        }
    },

    hide() {
        this.isOpen = false;
        this._pushedHistory = false;
        this.elements.page.hidden = true;
        document.body.style.overflow = '';
        this.elements.toggle?.setAttribute('aria-expanded', 'false');

        const after = this._afterClose;
        this._afterClose = null;
        if (after) after();
    },

    select(personId) {
        this._afterClose = () => Filters.showPerson(personId);
        this.close();
    },

    render() {
        const { grid, empty, count, search } = this.elements;
        if (!grid) return;

        const all = Filters.peopleList.filter((person) => person.id && person.name?.trim());
        const query = (search?.value || '').trim();
        const people = query
            ? all.filter((person) => Filters.personNameMatchesQuery(person.name, query))
            : all;
        const selected = new Set(State.getProperty('personIds'));

        if (count) {
            count.textContent = all.length ? `${all.length} ${all.length === 1 ? 'person' : 'people'}` : '';
        }

        const fragment = document.createDocumentFragment();
        people.forEach((person) => {
            const name = person.name.trim();
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = 'person-tile';
            tile.setAttribute('aria-label', `Show photos of ${name}`);
            if (selected.has(person.id)) tile.setAttribute('aria-current', 'true');

            const img = document.createElement('img');
            img.src = API.getPersonThumbnailUrl(person.id);
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            tile.appendChild(img);

            const label = document.createElement('span');
            label.className = 'person-tile-name';
            label.textContent = name;
            tile.appendChild(label);

            tile.addEventListener('click', () => this.select(person.id));
            fragment.appendChild(tile);
        });

        grid.replaceChildren(fragment);
        if (empty) {
            empty.hidden = people.length > 0;
            empty.textContent = all.length
                ? 'No one matches that name.'
                : 'No named people yet.';
        }
    },
};

window.People = People;
