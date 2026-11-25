/**
 * GitHub transport for chat channels (Bots 0.14): issues with a label (`bots` by default) in the
 * repositories named become requests, and their comments go on talking about them. Polling only:
 * Harness has no public address, so nothing waits for a webhook. Every minute it asks each
 * repository for the labelled issues and the comments changed since the last look, with an ETag, so
 * an unchanged answer (HTTP 304) costs no rate limit. A poll missed while the computer slept or
 * Harness was closed is caught up from the stored cursor.
 *
 * Transport only (lib/channels.mjs decides what a message means), with one difference from the
 * chat apps: there is no pairing. The connector vouches for who may start work (`VOUCHED`): a
 * message is `trusted` when its author is the repository's owner, a member or a collaborator; an
 * issue is trusted too when the person who put the label on it is a collaborator (only people with
 * triage access label issues, but an issue form can apply a label for anyone). Others are passed
 * on untrusted, and the hub ignores them without answering.
 *
 * - A repository is `owner/repo` on github.com and `host/owner/repo` on a GitHub Enterprise server
 *   (0.16, `cleanRepo`); one channel watches the repositories of one server, through its API
 *   (`apiBaseOf`), with a token of that server.
 * - `chatId` is the repository as written above, `threadId` the issue number: one issue is one
 *   Thread. An issue arrives once, as `{issue: {number, title, body, url, author, labeledBy}}` with
 *   the text `#12 Title` and its body; afterwards only comments on issues that arrived are passed
 *   on (`messageId` `c<id>`), never the bot's own (its account, or a body with the marker).
 * - `send(repo, text, {threadId})` posts a comment on that issue, ending with the hidden marker
 *   `<!-- dsh-bots -->`.
 * - On its first start the connector looks from now on: issues labelled before it ran are not
 *   picked up until they change (a new label, an edit). Its cursors live in the hub's record
 *   (`memo`), so a restart goes on where it stopped.
 *
 * @module dsh-hive/lib/channels/github
 */

export const kind = 'github';
/** A GitHub comment holds 65 536 characters; the hub splits longer replies. */
export const TEXT_LIMIT = 60_000;
export const MARKDOWN = true;
/** The connector says who may start work (`trusted` on each message): no pairing codes. */
export const VOUCHED = true;
/** What every comment the bots post ends with, so the next poll skips it. */
export const MARKER = '<!-- dsh-bots -->';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const POLL_MS = 60_000;
const PER_PAGE = 50;
const MAX_PAGES = 5;
const KEEP_ISSUES = 1000;
const COLLABORATOR_TTL_MS = 10 * 60_000;
/** Longest text a message carries into a prompt; an issue or comment longer than that is cut, with its address. */
const MAX_TEXT = 8000;
const clipText = (text, url) => {
  const chars = [...String(text ?? '')];
  return chars.length <= MAX_TEXT ? chars.join('') : `${chars.slice(0, MAX_TEXT).join('').trimEnd()}\n\n[… cut here; the whole of it: ${url || 'on GitHub'}]`;
};
export const TOKEN_REJECTED = 'GitHub rejected the token: make a new one with access to the repositories (Issues: read and write).';

/**
 * A repository as Bots keeps it (0.16): `owner/repo` on github.com, `host/owner/repo` on a GitHub
 * Enterprise server. Read from that, or from the repository's address: `https://host/owner/repo`
 * (and any page under it, `/issues/12`), `git@host:owner/repo.git`, `ssh://git@host/owner/repo`.
 * A host needs a dot or a port (`ghe.example.com`, `ghe:8443`), so that the kept form reads back the
 * same. '' when it is not a repository.
 * @param {string} text
 */
export function cleanRepo(text) {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return '';
  let host = '';
  let rest = '';
  let deep = true;
  let m;
  if ((m = /^git@([^:/]+):(.+)$/i.exec(s))) [host, rest] = [m[1], m[2]];
  else if ((m = /^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(s))) [host, rest] = [m[1], m[2]];
  else if ((m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(s))) [host, rest] = [m[1], m[2]];
  else if ((m = /^([^/]+)\/(.+)$/.exec(s)) && (m[1].includes('.') || m[1].includes(':')) && m[2].includes('/')) [host, rest] = [m[1], m[2]];
  else [rest, deep] = [s, false];
  host = host.toLowerCase().replace(/^www\.(?=github\.com(:|$))/, '');
  if (host === 'github.com' || host === 'github.com:443') host = '';
  // A host has a dot or a port, as a bare `host/owner/repo` needs: what this returns reads back the same.
  if (host && (!HOST_RE.test(host) || !/[.:]/.test(host))) return '';
  const parts = rest.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/');
  if (parts.length < 2 || (!deep && parts.length !== 2)) return '';
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo)) return '';
  return host ? `${host}/${owner}/${repo}` : `${owner}/${repo}`;
}

/** A kept repository's server (`''` for github.com) and its `owner/repo`. */
export function repoParts(repo) {
  const parts = String(repo ?? '').split('/');
  return parts.length === 3 ? { host: parts[0], path: `${parts[1]}/${parts[2]}` } : { host: '', path: String(repo ?? '') };
}

/** The REST API of a GitHub server: github.com's, a GHE.com subdomain's (`api.<host>`), else a GitHub Enterprise Server's (`/api/v3`). */
export function apiBaseOf(host) {
  if (!host) return 'https://api.github.com/';
  if (/\.ghe\.com$/i.test(host)) return `https://api.${host}/`;
  return `https://${host}/api/v3/`;
}

/** A repository's web address. */
export function repoUrl(repo) {
  const { host, path } = repoParts(repo);
  return `https://${host || 'github.com'}/${path}`;
}

/** The repositories a channel watches, from its `repos` field (any form `cleanRepo` reads), separated by commas, spaces or lines. */
export function reposOf(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\s,，]+/)) {
    const r = cleanRepo(raw);
    if (r && !out.some((x) => x.toLowerCase() === r.toLowerCase())) out.push(r);
  }
  return out;
}

const issueNumberOf = (url) => Number(/\/issues\/(\d+)$/.exec(String(url ?? ''))?.[1] ?? 0);
const later = (a, b) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * @param {{token: string, values?: {repos?: string, label?: string}, onMessage: Function, onStatus?: Function,
 *   log?: Function, memo?: {read: () => object, write: (m: object) => void}, fetchImpl?: Function, apiBase?: string,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>, now?: () => number, pollMs?: number, loop?: boolean}} opts
 *   `loop: false` (tests): no background polling; call `pollNow()`.
 */
export function createConnector(opts) {
  const token = String(opts.token ?? '').trim();
  const repos = reposOf(opts.values?.repos);
  // One token is one server's: the channel watches the repositories of one server.
  const hosts = [...new Set(repos.map((r) => repoParts(r).host))];
  const host = hosts[0] ?? '';
  const label = String(opts.values?.label ?? '').trim() || 'bots';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.apiBase ?? apiBaseOf(host);
  /** A repository's API path: `repos/owner/repo`. */
  const api = (repo) => `repos/${repoParts(repo).path}`;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? POLL_MS;
  const status = (s) => opts.onStatus?.(s);
  const log = (line) => opts.log?.(line);
  const sleep =
    opts.sleep ??
    ((ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
        signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      }));
  const abort = new AbortController();
  let stopped = false;
  let me = null;
  let loop = null;
  /** URL → {etag, body}: an unchanged answer is read from here. */
  const etags = new Map();
  /** `repo|login` → {yes, at}. */
  const collaborators = new Map();

  // What has been seen, per repository: the cursors and the issues passed on (their comments are passed on too).
  const memo = (() => {
    const m = opts.memo?.read?.() ?? {};
    return m && typeof m === 'object' && m.repos && typeof m.repos === 'object' ? m : { repos: {} };
  })();
  const save = () => {
    try {
      opts.memo?.write?.(memo);
    } catch (error) {
      log(`could not keep the cursors: ${error?.message ?? error}`);
    }
  };

  async function call(method, path, body) {
    const url = new URL(path, base).toString();
    const cached = method === 'GET' ? etags.get(url) : undefined;
    const res = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'dsh-bots',
        ...(cached ? { 'if-none-match': cached.etag } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: abort.signal,
    });
    if (res.status === 304 && cached) return { status: 200, body: cached.body, cached: true };
    let data = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }
    if (res.status === 401) throw Object.assign(new Error(TOKEN_REJECTED), { status: 401, fatal: true });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers?.get?.('x-ratelimit-reset') ?? 0) * 1000;
      const after = Number(res.headers?.get?.('retry-after') ?? 0) * 1000;
      const wait = Math.min(15 * 60_000, Math.max(after, reset ? reset - now() : 0, 60_000));
      throw Object.assign(new Error(`GitHub: ${data?.message ?? `HTTP ${res.status}`}`), { status: res.status, wait });
    }
    if (res.status >= 400) throw Object.assign(new Error(`GitHub: ${data?.message ?? `HTTP ${res.status}`}`), { status: res.status });
    const etag = res.headers?.get?.('etag');
    if (method === 'GET' && etag) etags.set(url, { etag, body: data });
    return { status: res.status, body: data };
  }

  const state = (repo) => {
    const key = repo.toLowerCase();
    const at = new Date(now()).toISOString();
    memo.repos[key] ??= { since: at, comments: at, lastComment: 0, issues: [] };
    return memo.repos[key];
  };

  /** Whether `login` may push to `repo` (cached a while); false when the token may not tell. */
  async function isCollaborator(repo, login) {
    const k = `${repo.toLowerCase()}|${login.toLowerCase()}`;
    const hit = collaborators.get(k);
    if (hit && now() - hit.at < COLLABORATOR_TTL_MS) return hit.yes;
    let yes = false;
    try {
      const r = await call('GET', `${api(repo)}/collaborators/${encodeURIComponent(login)}`);
      yes = r.status === 204;
    } catch {
      yes = false;
    }
    collaborators.set(k, { yes, at: now() });
    return yes;
  }

  /** Who put the label on an issue last, or ''. */
  async function labeler(repo, number) {
    try {
      const r = await call('GET', `${api(repo)}/issues/${number}/events?per_page=100`);
      const ev = (Array.isArray(r.body) ? r.body : []).filter((e) => e?.event === 'labeled' && String(e.label?.name ?? '').toLowerCase() === label.toLowerCase()).at(-1);
      return String(ev?.actor?.login ?? '');
    } catch {
      return '';
    }
  }

  const mine = (login, text) => (me && String(login ?? '').toLowerCase() === me.login.toLowerCase()) || String(text ?? '').includes(MARKER);

  async function pollIssues(repo) {
    const st = state(repo);
    let since = st.since;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const q = new URLSearchParams({ labels: label, state: 'open', sort: 'updated', direction: 'asc', since: st.since, per_page: String(PER_PAGE), page: String(page) });
      const r = await call('GET', `${api(repo)}/issues?${q}`);
      const list = Array.isArray(r.body) ? r.body : [];
      for (const it of list) {
        since = later(since, it?.updated_at);
        const number = Number(it?.number);
        if (!number || it.pull_request || st.issues.includes(number)) continue;
        const author = String(it.user?.login ?? '');
        if (mine(author, it.body)) continue;
        const by = await labeler(repo, number);
        const trusted = TRUSTED.has(String(it.author_association ?? '')) || (by && by.toLowerCase() !== author.toLowerCase() ? await isCollaborator(repo, by) : false);
        st.issues.push(number);
        if (st.issues.length > KEEP_ISSUES) st.issues.splice(0, st.issues.length - KEEP_ISSUES);
        const title = String(it.title ?? '').trim();
        const body = String(it.body ?? '').trim();
        const who = trusted && by && !TRUSTED.has(String(it.author_association ?? '')) ? by : author;
        opts.onMessage({
          chatId: repo,
          threadId: String(number),
          messageId: `i${it.id ?? number}`,
          userId: who,
          userName: who,
          text: clipText([`#${number} ${title}`, body].filter(Boolean).join('\n\n'), String(it.html_url ?? '')),
          isDirect: false,
          mentioned: true,
          trusted,
          chatTitle: repo,
          issue: { repo, number, title, body, url: String(it.html_url ?? ''), author, ...(by ? { labeledBy: by } : {}) },
        });
      }
      if (list.length < PER_PAGE) break;
    }
    st.since = since;
  }

  async function pollComments(repo) {
    const st = state(repo);
    if (!st.issues.length) return;
    let since = st.comments;
    let last = Number(st.lastComment ?? 0);
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const q = new URLSearchParams({ sort: 'updated', direction: 'asc', since: st.comments, per_page: String(PER_PAGE * 2), page: String(page) });
      const r = await call('GET', `${api(repo)}/issues/comments?${q}`);
      const list = Array.isArray(r.body) ? r.body : [];
      for (const c of list) {
        since = later(since, c?.updated_at);
        const id = Number(c?.id ?? 0);
        // Comment ids only grow: an edited old comment is not a new message.
        if (!id || id <= Number(st.lastComment ?? 0)) continue;
        last = Math.max(last, id);
        const number = issueNumberOf(c.issue_url);
        if (!st.issues.includes(number)) continue;
        const login = String(c.user?.login ?? '');
        if (mine(login, c.body)) continue;
        opts.onMessage({
          chatId: repo,
          threadId: String(number),
          messageId: `c${id}`,
          userId: login,
          userName: login,
          text: clipText(String(c.body ?? '').trim(), String(c.html_url ?? '')),
          isDirect: false,
          mentioned: true,
          trusted: TRUSTED.has(String(c.author_association ?? '')),
          chatTitle: repo,
        });
      }
      if (list.length < PER_PAGE * 2) break;
    }
    st.comments = since;
    st.lastComment = last;
  }

  /** One look at every repository. */
  async function pollNow() {
    for (const repo of repos) {
      if (stopped) return;
      await pollIssues(repo);
      await pollComments(repo);
    }
    save();
  }

  async function run() {
    while (!stopped) {
      await sleep(pollMs, abort.signal);
      if (stopped) return;
      try {
        await pollNow();
        status({ state: 'connected' });
      } catch (error) {
        if (stopped) return;
        if (error?.fatal) {
          status({ state: 'error', detail: error.message, fatal: true });
          return;
        }
        status({ state: 'error', detail: `${error?.message ?? error}; trying again` });
        if (error?.wait) await sleep(error.wait, abort.signal);
      }
    }
  }

  return {
    /** Check the token and the repositories, set the cursors on a first start, then poll in the background. */
    async start() {
      if (stopped) throw new Error('the connector was stopped');
      if (!token) throw Object.assign(new Error('no token'), { fatal: true });
      if (!repos.length) throw Object.assign(new Error('name the repositories to watch, as owner/repo'), { fatal: true });
      if (hosts.length > 1) throw Object.assign(new Error(`one GitHub Issues app watches the repositories of one GitHub server, with its token; these are on ${hosts.map((h) => h || 'github.com').join(' and ')}: add the app once more for the other server`), { fatal: true });
      status({ state: 'connecting' });
      const user = await call('GET', 'user');
      me = { id: String(user.body?.id ?? ''), login: String(user.body?.login ?? '') };
      for (const repo of repos) {
        try {
          await call('GET', api(repo));
        } catch (error) {
          if (error?.status === 404) throw Object.assign(new Error(`GitHub: this token cannot see ${repo}`), { fatal: true });
          throw error;
        }
        state(repo);
      }
      save();
      if (opts.loop !== false) loop = run();
      return { id: me.id, username: me.login, name: String(user.body?.name ?? '') };
    },

    async stop() {
      stopped = true;
      abort.abort();
      await loop?.catch?.(() => {});
    },

    /** A comment on issue `threadId` of repository `chatId`. */
    async send(chatId, text, o = {}) {
      const repo = cleanRepo(chatId);
      const number = Number(o?.threadId ?? 0);
      if (!repo || !number) throw new Error('a GitHub reply goes to an issue: it needs the repository and the issue number');
      if (repoParts(repo).host !== host) throw new Error(`${repo} is not on the GitHub server this app watches`);
      const r = await call('POST', `${api(repo)}/issues/${number}/comments`, { body: `${String(text ?? '').trim()}\n\n${MARKER}` });
      return { ids: r.body?.id ? [String(r.body.id)] : [] };
    },

    /** GitHub shows no typing; nothing to do. */
    async typing() {},

    pollNow,
  };
}
