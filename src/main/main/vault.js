let BASE = 'http://127.0.0.1:8765';
/** For tests only: override the vault base URL. */
export function _setBaseForTest(url) {
    BASE = url;
}
export class VaultUnavailable extends Error {
    constructor() {
        super('Vault server is not running on 127.0.0.1:8765.');
        this.name = 'VaultUnavailable';
    }
}
export class SaveConflict extends Error {
    currentMtime;
    constructor(currentMtime) {
        super('Note changed on disk since you opened it.');
        this.currentMtime = currentMtime;
        this.name = 'SaveConflict';
    }
}
async function req(path, init) {
    let res;
    try {
        res = await fetch(BASE + path, {
            ...init,
            headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
            signal: AbortSignal.timeout(15_000),
        });
    }
    catch {
        throw new VaultUnavailable();
    }
    const body = (await res.json().catch(() => ({})));
    if (res.status === 409 && typeof body.mtime === 'number') {
        throw new SaveConflict(body.mtime);
    }
    if (!res.ok)
        throw new Error(String(body.error ?? `${res.status} ${path}`));
    return body;
}
const titleOf = (p) => p.split('/').pop().replace(/\.md$/i, '');
export async function list() {
    // The server's /notes shape is its own; normalise to VaultNote here so the
    // renderer never sees two spellings of the same thing.
    const raw = await req('/notes');
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map((r) => {
        const o = r;
        const path = String(o.path ?? o.rel ?? '');
        return {
            path,
            title: String(o.title ?? titleOf(path)),
            mtime: Number(o.mtime ?? 0),
        };
    });
}
export async function read(path) {
    const o = await req(`/note?path=${encodeURIComponent(path)}`);
    return { path: o.path, text: o.text, mtime: o.mtime, title: titleOf(o.path) };
}
export async function save(path, text, mtime) {
    const o = await req('/save', {
        method: 'POST',
        body: JSON.stringify({ path, text, mtime }),
    });
    return { path, title: titleOf(path), mtime: o.mtime };
}
/** Folder tree, derived from the flat note list. No second source of truth. */
export async function tree() {
    const notes = await list();
    const root = {
        name: 'Universal Vault',
        path: '',
        kind: 'folder',
        children: [],
    };
    for (const n of notes) {
        const parts = n.path.split('/');
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = parts[i];
            const at = parts.slice(0, i + 1).join('/');
            let next = cur.children.find((c) => c.kind === 'folder' && c.name === seg);
            if (!next) {
                next = { name: seg, path: at, kind: 'folder', children: [] };
                cur.children.push(next);
            }
            cur = next;
        }
        cur.children.push({ name: parts.at(-1), path: n.path, kind: 'note' });
    }
    sort(root);
    return root;
}
function sort(node) {
    if (!node.children)
        return;
    node.children.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
        a.name.localeCompare(b.name));
    node.children.forEach(sort);
}
const WIKILINK = /\[\[([^\]|#]+)/g;
/**
 * Graph edges from [[wikilinks]]. This is a CACHE, per the project's own rule:
 * the projection must be deletable and rebuildable from the files, never
 * authoritative. Nothing here writes anything.
 *
 * ponytail: O(n) full rescan per call, no incremental index. Notes are in the
 * low hundreds. Add a mtime-keyed cache only if a measurement says to.
 */
export async function graph() {
    const notes = await list();
    const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.path]));
    const links = [];
    await Promise.all(notes.map(async (n) => {
        let text;
        try {
            text = (await read(n.path)).text;
        }
        catch {
            return;
        }
        for (const m of text.matchAll(WIKILINK)) {
            const target = byTitle.get(m[1].trim().toLowerCase());
            if (target && target !== n.path)
                links.push({ from: n.path, to: target });
        }
    }));
    return { nodes: notes.map((n) => n.path), links };
}
export async function backlinks(path) {
    const g = await graph();
    return [...new Set(g.links.filter((l) => l.to === path).map((l) => l.from))];
}
