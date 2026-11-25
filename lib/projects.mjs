/**
 * Projects (Bots 0.12): what a piece of work belongs to. A request (need) may be filed under one
 * project, and gets the project's next number there, so the board names it `OPC-12`. A project
 * gives its tasks two things: its folder (`dir`), where their conversations work (a Harness
 * workspace of its own), and its brief, which every task of the project reads.
 *
 * A team says who works; a project says on what. Bots of any team work on any project.
 *
 * `projects.json` under the bots cache holds `{version: 1, projects}`. It is read on first use and
 * written whole through a temp file and a rename; a missing file starts empty, one that is not JSON
 * in the expected shape is set aside as `projects.json.corrupt-<time>` before the first write
 * replaces it.
 *
 * @module dsh-hive/lib/projects
 */

import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import { cleanRepo } from './channels/github.mjs';
import { pinyinInitial } from './store.mjs';

export const PROJECT_ID_RE = /^pj[a-z0-9]{8}$/;
/** A project's key: a capital letter, then 1–5 capital letters or digits (`OPC`, `WEB2`). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;
/** A card's reference: the key, a hyphen and its number (`OPC-12`). */
export const CARD_REF_RE = /^([A-Z][A-Z0-9]{1,5})-([1-9][0-9]{0,6})$/;
export const MAX_PROJECT_NAME = 60;
/** Longest brief, in characters: it is in the prompt of every task of the project. */
export const MAX_BRIEF = 4000;
/** Most projects one Bots keeps. */
export const MAX_PROJECTS = 100;

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `pj` and 8 random lowercase letters and digits. */
export function newProjectId() {
  let id = 'pj';
  for (let i = 0; i < 8; i += 1) id += ALNUM[randomInt(ALNUM.length)];
  return id;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const oneLine = (v, max) => [...String(v ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');

/** A key as typed (`opc`, ` Web-2 `) in its stored form (`OPC`, `WEB2`), or '' when nothing is left. */
export function cleanKey(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 6);
}

/**
 * A key for a new project from its name, not one of `taken`: the first letters of its words
 * ("One-person company" → OPC), pinyin initials of a Chinese name ("内容工作室" → NRGZS), else the
 * first three letters of its one word; `PRJ` when that leaves less than two, and numbered when
 * taken (`OPC2`).
 * @param {string} name
 * @param {Iterable<string>} [taken]
 */
export function suggestKey(name, taken = []) {
  const used = new Set([...taken].map((k) => String(k).toUpperCase()));
  const text = String(name ?? '').trim();
  let base = '';
  const han = [...text].filter((c) => /[一-鿿]/.test(c));
  if (han.length) base = han.map((c) => pinyinInitial(c)).join('');
  if (!base) {
    const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
    base = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  }
  base = cleanKey(base).slice(0, 5);
  if (base.length < 2) base = `${base}PRJ`.slice(0, 3);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const k = `${base.slice(0, 6 - String(n).length)}${n}`;
    if (!used.has(k)) return k;
  }
  return base;
}

/**
 * A folder as a project keeps it: `~` expanded against `home`, absolute and normalized; '' for none.
 * Throws when it is not absolute, or is not an existing folder.
 * @param {string} text
 * @param {string} home
 */
export function cleanDir(text, home) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) throw new Error(`the folder must be a full path (like ~/code/app or /Users/me/app), not "${raw}"`);
  const dir = normalize(expanded).replace(/(.)\/+$/, '$1');
  if (dir === '/') throw new Error('a project folder cannot be the whole disk (/): pick the folder its work is in');
  let st = null;
  try {
    st = statSync(dir);
  } catch {
    throw new Error(`there is no folder ${dir}`);
  }
  if (!st.isDirectory()) throw new Error(`${dir} is a file, not a folder`);
  return dir;
}

/**
 * A GitHub repository as a project keeps it, or '' (0.14): `owner/repo` on github.com,
 * `host/owner/repo` on a GitHub Enterprise server (0.16), from its address too.
 */
export { cleanRepo };

/** A stored project in its known shape, unknown fields kept; null when it is not one. */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || !PROJECT_ID_RE.test(String(raw.id ?? ''))) return null;
  const key = cleanKey(raw.key);
  const name = oneLine(raw.name, MAX_PROJECT_NAME);
  if (!PROJECT_KEY_RE.test(key) || !name) return null;
  const createdAt = time(raw.createdAt) || Date.now();
  const last = Number.isInteger(raw.last) && raw.last > 0 ? raw.last : 0;
  return {
    ...raw,
    id: raw.id,
    key,
    name,
    brief: str(raw.brief, MAX_BRIEF).trim(),
    dir: typeof raw.dir === 'string' && isAbsolute(raw.dir) ? raw.dir : '',
    repo: cleanRepo(raw.repo),
    last,
    createdAt,
    updatedAt: time(raw.updatedAt) || createdAt,
  };
}

/**
 * The projects file under `dir`. Writes go through at once; `onChange(fn)` hears each one.
 * `home` expands `~` in folders.
 * @param {string} dir
 * @param {{now?: () => number, home?: string}} [opts]
 */
export function createProjects(dir, { now = Date.now, home = '' } = {}) {
  const file = join(dir, 'projects.json');
  /** @type {{version: 1, projects: object[]}|null} */
  let data = null;
  const listeners = new Set();

  const setAside = () => {
    try {
      let to = `${file}.corrupt-${now()}`;
      for (let n = 1; existsSync(to); n += 1) to = `${file}.corrupt-${now()}-${n}`;
      renameSync(file, to);
    } catch {
      // It goes when the next write replaces it.
    }
  };

  const load = () => {
    if (data) return data;
    let parsed = null;
    let text = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`cannot read ${file} (${error?.code ?? error?.message ?? error}); fix or move it, projects are not loaded until then`, { cause: error });
    }
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
        parsed = null;
        setAside();
      }
    }
    data = { version: 1, projects: [] };
    const keys = new Set();
    for (const raw of parsed?.projects ?? []) {
      const p = normalizeProject(raw);
      if (!p || data.projects.some((x) => x.id === p.id) || keys.has(p.key)) continue;
      keys.add(p.key);
      data.projects.push(p);
    }
    return data;
  };

  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      // Kept in memory; the next write tries again.
    }
  };

  const changed = (p) => {
    save();
    for (const fn of listeners) {
      try {
        fn(p);
      } catch {
        // A listener must not break a write.
      }
    }
  };

  /** A project by id or key (any case); undefined when there is none. */
  const find = (ref) => {
    load();
    const s = String(ref ?? '').trim();
    if (!s) return undefined;
    if (PROJECT_ID_RE.test(s)) return data.projects.find((p) => p.id === s);
    const key = cleanKey(s);
    return data.projects.find((p) => p.key === key);
  };

  /** The fields a person or a bot may set, checked; `prev` is the project being changed. */
  const fieldsOf = (input, prev) => {
    const out = {};
    if (input.name !== undefined || !prev) {
      const name = oneLine(input.name, MAX_PROJECT_NAME);
      if (!name) throw new Error('a project needs a name');
      out.name = name;
    }
    if (input.key !== undefined || !prev) {
      const typed = String(input.key ?? '').trim();
      const others = data.projects.filter((p) => p.id !== prev?.id).map((p) => p.key);
      const key = typed ? cleanKey(typed) : prev?.key ?? suggestKey(out.name ?? prev?.name, others);
      if (!PROJECT_KEY_RE.test(key)) throw new Error(`a project key is 2–6 capital letters or digits and starts with a letter (like OPC), not "${typed}"`);
      if (others.includes(key)) throw new Error(`the key ${key} is taken by another project`);
      out.key = key;
    }
    if (input.brief !== undefined) out.brief = str(input.brief, MAX_BRIEF).trim();
    if (input.dir !== undefined) out.dir = cleanDir(input.dir, home);
    if (input.repo !== undefined) {
      const typed = String(input.repo ?? '').trim();
      const repo = cleanRepo(typed);
      if (typed && !repo) throw new Error(`a repository is owner/repo, or its address (https://github.com/owner/repo, or on GitHub Enterprise https://github.example.com/owner/repo), not "${typed}"`);
      const other = repo ? data.projects.find((p) => p.id !== prev?.id && p.repo.toLowerCase() === repo.toLowerCase()) : null;
      if (other) throw new Error(`${repo} belongs to project ${other.key} already`);
      out.repo = repo;
    }
    return out;
  };

  return {
    /** Every project, by key. */
    list() {
      load();
      return [...data.projects].sort((a, b) => a.key.localeCompare(b.key));
    },

    get: (ref) => find(ref),

    /**
     * A new project. `key` is suggested from the name when left out; `dir` must be an existing folder.
     * @param {{name: string, key?: string, brief?: string, dir?: string}} input
     */
    create(input = {}) {
      load();
      if (data.projects.length >= MAX_PROJECTS) throw new Error(`Bots keeps at most ${MAX_PROJECTS} projects; remove one first`);
      const fields = fieldsOf(input, null);
      const at = now();
      let id = newProjectId();
      while (data.projects.some((p) => p.id === id)) id = newProjectId();
      const p = normalizeProject({ id, brief: '', dir: '', repo: '', ...fields, last: 0, createdAt: at, updatedAt: at });
      data.projects.push(p);
      changed(p);
      return p;
    },

    /** Change a project's name, key, brief or folder (only the fields given). */
    update(ref, input = {}) {
      const p = find(ref);
      if (!p) throw new Error('no such project');
      Object.assign(p, fieldsOf(input, p), { updatedAt: now() });
      changed(p);
      return p;
    },

    /** The next card number of the project (its numbers only go up, so a removed card's is not reused). */
    take(ref) {
      const p = find(ref);
      if (!p) return 0;
      p.last += 1;
      p.updatedAt = now();
      changed(p);
      return p.last;
    },

    remove(ref) {
      const p = find(ref);
      if (!p) return undefined;
      data.projects = data.projects.filter((x) => x.id !== p.id);
      changed(null);
      return p;
    },

    /** `fn(project)` after each write (`null` for a removal). Returns an unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
