/**
 * Images in Bots messages (Bots 0.17): the references Harness's attachment store gave the images a
 * person sent from the panel, or that reached a bot with a message, by attachment id. The bytes stay
 * in the attachment store (verified on every read); this index only lets the panel show an image of a
 * message, and a bot pass an image it saw on to a teammate by its id. In `images.json`.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Media types the attachment store takes as images. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Images one message carries at most. */
export const MAX_MESSAGE_IMAGES = 10;
/** References kept: the oldest go first (their messages have long left the panel). */
const KEEP = 5000;
const ID_RE = /^[A-Za-z0-9_.:-]{6,160}$/;

/** An attachment id as a message, a tool call or a URL may name one, or ''. */
export function imageId(v) {
  const s = String(v ?? '').trim().replace(/^image\//, '');
  return ID_RE.test(s) ? s : '';
}

/**
 * A durable image reference as the attachment store gives it (`ImageAttachmentRef`), or null when it
 * is not one. Only its own fields are kept.
 */
export function cleanRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const id = imageId(ref.attachmentId);
  if (!id || !IMAGE_TYPES.includes(ref.mediaType)) return null;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const bytes = n(ref.bytes);
  const width = n(ref.width);
  const height = n(ref.height);
  if (bytes === null || width === null || height === null) return null;
  const out = { attachmentId: id, mediaType: ref.mediaType, bytes, width, height };
  if (typeof ref.name === 'string' && ref.name.trim()) out.name = ref.name.trim().slice(0, 200);
  const o = ref.originalDimensions;
  if (o && n(o.width) !== null && n(o.height) !== null) out.originalDimensions = { width: n(o.width), height: n(o.height) };
  return out;
}

/** The image references in message content blocks (`{type: 'image', attachment}`), in order. */
export function refsInContent(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b?.type === 'image' ? [cleanRef(b.attachment)].filter(Boolean) : []));
}

/** A list of attachment ids (an array, or one id), without repeats or bad ones. */
export function idList(v) {
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v];
  return [...new Set(list.map(imageId).filter(Boolean))];
}

export function createImages(dir) {
  const file = join(dir, 'images.json');
  let refs = new Map();
  let seen = -1;
  const load = () => {
    let m = 0;
    try {
      m = statSync(file).mtimeMs;
    } catch {
      m = 0;
    }
    if (m === seen) return;
    seen = m;
    refs = new Map();
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      for (const r of Array.isArray(raw?.images) ? raw.images : []) {
        const ref = cleanRef(r);
        if (ref) refs.set(ref.attachmentId, ref);
      }
    } catch {
      // None yet.
    }
  };
  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ images: [...refs.values()] }), 'utf8');
      renameSync(tmp, file);
      seen = statSync(file).mtimeMs;
    } catch {
      // The index is a convenience: a message keeps its images in its bot's conversation.
    }
  };
  return {
    /** Keep these references (newest last); returns the clean ones. */
    remember(list) {
      load();
      const clean = (Array.isArray(list) ? list : [list]).map(cleanRef).filter(Boolean);
      let changed = false;
      for (const ref of clean) {
        const had = refs.get(ref.attachmentId);
        if (had && JSON.stringify(had) === JSON.stringify(ref)) continue;
        refs.delete(ref.attachmentId);
        refs.set(ref.attachmentId, ref);
        changed = true;
      }
      while (refs.size > KEEP) refs.delete(refs.keys().next().value);
      if (changed) save();
      return clean;
    },
    /** The reference of attachment `id`, or undefined. */
    get(id) {
      load();
      const ref = refs.get(imageId(id));
      return ref ? { ...ref } : undefined;
    },
    size() {
      load();
      return refs.size;
    },
  };
}

/** What the panel shows of an image: its id, where to load it, its size and name. */
export function imageView(ref, base) {
  return { id: ref.attachmentId, url: `${base}/image/${encodeURIComponent(ref.attachmentId)}`, width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}) };
}

/** The line after a message's images: their ids, which a bot names to pass them on. */
export function imageNoteText(refs) {
  const list = refs.map((r) => (r.name ? `${r.attachmentId} (${r.name})` : r.attachmentId)).join(', ');
  return `[${refs.length === 1 ? 'Image attached' : `${refs.length} images attached`}: ${list}. To pass ${refs.length === 1 ? 'it' : 'them'} on to a teammate, name ${refs.length === 1 ? 'its id' : 'their ids'} in \`images\`.]`;
}
