/**
 * Where a bot may fetch from and send data to — the two A-class items borrowed from dsh-bot.
 *
 * Both sit *below* the approval switch: a person saying yes does not buy them out.
 *
 * - A local or private address is never fetched. A model reading `http://127.0.0.1:…` is an
 *   SSRF hole, and the person's machine is not the web. This holds however the site list is set.
 * - `browseMode: 'allowlist'` narrows it further: only hosts on `siteAllow` (and their
 *   subdomains) are reachable at all.
 * - `egressCheck`: a command that uploads (`curl -F/-T`, `wget --post-file`, `scp`, `rsync`…)
 *   while naming a path inside the bot's workspace is the data leaving, not a lookup — refused
 *   with an explanation of what to do instead.
 *
 * @module dsh-hive/lib/egress
 */

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
const LOCAL = new Set(['localhost', '0.0.0.0', '::1', '::', 'metadata.google.internal', 'instance-data']);

/** True for loopback, link-local, RFC1918 and `*.local` / `*.internal` names. */
export function isPrivateHost(raw) {
  const h = String(raw ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (LOCAL.has(h) || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  // An IPv6 literal is never one of the sites a bot is meant to read.
  if (h.includes(':')) return true;
  return PRIVATE.some((re) => re.test(h));
}

/** Hostnames of the http(s) URLs in a command. */
export function hostsIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\bhttps?:\/\/[^\s'"`<>)\]]+/gi)) {
    try {
      out.push(new URL(m[0]).hostname);
    } catch {
      // Not a URL after all.
    }
  }
  return out;
}

/** `api.example.com` matches an entry `example.com`. */
const onList = (host, sites) =>
  sites.some((raw) => {
    const want = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[/:].*$/, '');
    if (!want) return false;
    return host === want || host.endsWith(`.${want}`);
  });

/** curl/wget/scp/rsync carrying a file, as opposed to a plain GET. */
const UPLOAD = /(curl|wget|scp|sftp|rsync)\b[\s\S]*?(-F\s|--form\b|-T\s|--upload-file\b|--data-binary\s*@|--post-file\b|--data\s*@|-d\s*@|--body-file\b|--infile\b|-InFile\b)/i;
/** PowerShell's own client: `Invoke-WebRequest/-RestMethod -Method Post -Body ...` or `-InFile`. */
const PWSH_UPLOAD = /(invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b)[\s\S]*?(-method\s+(post|put|patch)|-body\b|-infile\b)/i;
/** Reading a file into a variable or string, the usual way a PowerShell upload gets fed. */
const READS_BACK = /(get-content|\bgc\s|\btype\s+|\bcat\s+|readalltext|openread)/i;

/**
 * Why this call may not go out, or undefined.
 * @param {{name?: string, arguments?: object}} call
 * @param {{workspace?: string, sites?: string[], mode?: 'open'|'allowlist', check?: boolean}} opts
 */
export function egressReason(call, { workspace = '', sites = [], mode = 'open', check = true } = {}) {
  const name = String(call?.name ?? '');
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const listing = Array.isArray(sites) ? sites.filter((s) => String(s ?? '').trim() !== '') : [];
  const gate = (host, what) => {
    if (isPrivateHost(host)) {
      return `Refused: ${what}指向 ${host}，是本机或内网地址。bot 只能访问公网；确实要访问，请在设置里把站点访问改成「只允许清单」，并在清单里写明这个地址。`;
    }
    if (mode === 'allowlist' && !onList(String(host).toLowerCase(), listing)) {
      return `Refused: ${what}指向 ${host}，不在允许清单里。当前站点访问是「只允许清单」模式，要在设置里加入这个站点后才会放行。`;
    }
    return undefined;
  };
  if (name === 'web_fetch') {
    const url = String(args.url ?? '').trim();
    if (!url) return undefined;
    try {
      return gate(new URL(url).hostname, '这次网页抓取');
    } catch {
      return undefined;
    }
  }
  const command = String(args.command ?? '');
  if (!command) return undefined;
  for (const host of hostsIn(command)) {
    const bad = gate(host, '这条命令里的地址');
    if (bad) return bad;
  }
  if (check && workspace && (UPLOAD.test(command) || PWSH_UPLOAD.test(command))) {
    const flat = command.replace(/\//g, '\\').toLowerCase();
    const base = workspace.replace(/\//g, '\\').toLowerCase().replace(/\\$/, '');
    // Either the command names a file in the workspace, reads one, or feeds a file with `@name`.
    const uploadsFile =
      READS_BACK.test(command) ||
      /@["']?[^\s"']*\.[a-z0-9]{1,8}\b/i.test(command) ||
      /(--post-file=|--upload-file=|-infile\s|-t\s)\S+/i.test(command);
    if (flat.includes(base) || uploadsFile) {
      return `Refused: 这条命令看起来会把工作区里的数据上传出去（${command.slice(0, 140)}）。外传检查开着：请先把要传的文件和目的地写给用户，由用户决定要不要传。`;
    }
  }
  return undefined;
}

/** The settings the page round-trips, normalised. */
export function normalizeEgress(s = {}) {
  return {
    browseMode: s.browseMode === 'allowlist' ? 'allowlist' : 'open',
    siteAllow: Array.isArray(s.siteAllow)
      ? [
          ...new Set(
            s.siteAllow
              .filter((x) => typeof x === 'string')
              .map((x) => x.trim().toLowerCase())
              .filter(Boolean),
          ),
        ].slice(0, 200)
      : [],
    egressCheck: s.egressCheck !== false,
  };
}