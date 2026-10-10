/** The owner's Usage page: who's been on, who hasn't, and what they've looked at. */

const Usage = {
    REFRESH_MS: 30000,

    async init() {
        await this.load();
        setInterval(() => !document.hidden && this.load(), this.REFRESH_MS);
    },

    async load() {
        let data;
        try {
            data = await API.get('/usage');
        } catch (error) {
            document.getElementById('usage-sub').textContent = 'Couldn’t load activity.';
            return;
        }
        this.renderPeople(data);
        this.renderFeed(data);
    },

    ago(ts, now) {
        if (!ts) return null;
        const s = Math.max(0, now - ts);
        if (s < 90) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
        const d = Math.round(h / 24);
        if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
        return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    },

    face(person) {
        const face = document.createElement('span');
        face.className = 'presence-face presence-face-md';
        if (person.personId) {
            const img = document.createElement('img');
            img.src = API.getPersonThumbnailUrl(person.personId);
            img.alt = '';
            face.appendChild(img);
        } else {
            face.textContent = (person.name || '?').slice(0, 1).toUpperCase();
        }
        return face;
    },

    where(person) {
        return { photo: 'looking at a photo', map: 'on the map', people: 'browsing people' }[person.where] || 'browsing';
    },

    renderPeople({ people, now }) {
        // Here now first, then most recent, then never visited.
        const order = (p) => (p.here ? 3e12 : p.last || 0);
        const sorted = [...people].sort((a, b) => order(b) - order(a));
        const fragment = document.createDocumentFragment();
        sorted.forEach((p) => {
            const card = document.createElement('article');
            card.className = `usage-card${p.here ? ' is-here' : ''}${p.last ? '' : ' is-never'}`;
            card.appendChild(this.face(p));

            const main = document.createElement('div');
            main.className = 'usage-card-main';
            const name = document.createElement('h3');
            name.textContent = p.name;
            const status = document.createElement('p');
            status.className = 'usage-status';
            status.textContent = p.here
                ? `Here now, ${this.where(p)}`
                : p.last
                  ? `Last on ${this.ago(p.last, now)}`
                  : 'Hasn’t visited yet';
            main.append(name, status);
            card.appendChild(main);

            const stats = document.createElement('dl');
            stats.className = 'usage-stats';
            [
                ['Visits', p.visits],
                ['Photos', p.photos],
                ['Saved', p.saves],
            ].forEach(([label, value]) => {
                const item = document.createElement('div');
                const dt = document.createElement('dt');
                dt.textContent = label;
                const dd = document.createElement('dd');
                dd.textContent = value.toLocaleString();
                item.append(dd, dt);
                stats.appendChild(item);
            });
            card.appendChild(stats);
            fragment.appendChild(card);
        });
        document.getElementById('usage-people').replaceChildren(fragment);
        const here = people.filter((p) => p.here).length;
        document.getElementById('usage-sub').textContent =
            `${here ? `${here} here now · ` : ''}Visits, photos opened and saves in the last 30 days`;
    },

    renderFeed({ recent, people, now }) {
        const faces = Object.fromEntries(people.map((p) => [p.email, p]));
        const verbs = {
            visit: 'came by',
            photo: 'opened a photo',
            download: 'downloaded a photo',
            share: 'shared a photo',
            copy: 'copied a photo',
        };
        const fragment = document.createDocumentFragment();
        recent.forEach((e) => {
            const row = document.createElement('li');
            row.className = 'usage-event';
            row.appendChild(this.face(faces[e.email] || { name: e.name }));
            const text = document.createElement('p');
            const who = document.createElement('strong');
            who.textContent = e.name;
            text.append(who, ` ${verbs[e.kind] || e.kind}`);
            const when = document.createElement('span');
            when.textContent = this.ago(e.ts, now);
            text.appendChild(when);
            row.appendChild(text);
            if (e.assetId) {
                const thumb = document.createElement('img');
                thumb.className = 'usage-thumb';
                thumb.src = API.getThumbnailUrl(e.assetId, 'thumbnail');
                thumb.alt = '';
                thumb.loading = 'lazy';
                row.appendChild(thumb);
            }
            fragment.appendChild(row);
        });
        document.getElementById('usage-feed').replaceChildren(fragment);
        document.getElementById('usage-empty').hidden = recent.length > 0;
    },
};

Usage.init();
