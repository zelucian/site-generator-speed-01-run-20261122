// A fast drop-in replacement for makefun-site 1.0.0: build(input) turns one site's
// sources into its output tree, a JSON object of path -> text, byte-identical to the
// reference. Written fresh for speed: bulk scanning, fast paths for the common ASCII
// cases, and a single fused Markdown lex+render pass. No dependencies, no I/O, no
// clock, no randomness: the output is a function of the input alone.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const ESC_BY_CODE = new Array(128).fill(null);
ESC_BY_CODE[38] = '&amp;';
ESC_BY_CODE[60] = '&lt;';
ESC_BY_CODE[62] = '&gt;';
ESC_BY_CODE[34] = '&quot;';
ESC_BY_CODE[39] = '&#39;';
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      const e = ESC_BY_CODE[c];
      if (e !== null) {
        out += text.slice(last, i) + e;
        last = i + 1;
      }
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

export const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * Pure-ASCII text is unchanged by NFKD and holds no combining marks, so it skips
 * the normalisation entirely.
 */
export function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    // Pure ASCII: NFKD changes nothing and there are no marks to drop, so the run-collapsing scan below
    // is exactly: lower-case (A-Z only, which is all toLowerCase touches in ASCII), every run of
    // non-[a-z0-9] as one "-", none leading, cut at SLUG_MAX, no "-" left at the end.
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
    let end = out.length;
    while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
    out = out.slice(0, end);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    else {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
    if (out.length >= SLUG_MAX) break;
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a code unit is whitespace in JavaScript's \s sense. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;
function isWSCode(c) {
  return WS_TABLE[c] === 1;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at either end. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether every character of `key` is a-z or _. */
function isKeyChars(key) {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The close is found before any line is read, as the reference does; the body is a slice, never split.
 */
export function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let closePos = -1;
  let closeEnd = -1;
  let scan = pos;
  while (scan < text.length) {
    const e = text.indexOf('\n', scan);
    const lineEnd = e === -1 ? text.length : e;
    if (
      lineEnd - scan === 3 &&
      text.charCodeAt(scan) === 45 &&
      text.charCodeAt(scan + 1) === 45 &&
      text.charCodeAt(scan + 2) === 45
    ) {
      closePos = scan;
      closeEnd = lineEnd;
      break;
    }
    if (e === -1) break;
    scan = e + 1;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = pos;
  let lineNo = 2;
  while (lineStart < closePos) {
    const e = text.indexOf('\n', lineStart);
    const lineEnd = e === -1 ? closePos : e;
    const line = text.slice(lineStart, lineEnd);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      const colon = line.indexOf(':');
      if (colon <= 0) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, colon);
      if (!isKeyChars(key)) return { error: `line ${lineNo} is not "key: value"` };
      let raw;
      if (colon === line.length - 1) raw = '';
      else if (line.charCodeAt(colon + 1) === 32) {
        raw = line.slice(colon + 2);
        let e2 = raw.length;
        while (e2 > 0 && (raw.charCodeAt(e2 - 1) === 32 || raw.charCodeAt(e2 - 1) === 9)) e2--;
        raw = raw.slice(0, e2);
      } else return { error: `line ${lineNo} is not "key: value"` };
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd === text.length ? text.length : closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

const WS_RE = /\s/;

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let j = d;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j >= line.length) return null;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return { depth: d, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let j = 3; j < line.length; j++) {
    const c2 = line.charCodeAt(j);
    if (c2 !== 32 && c2 !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletMatch(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's [number, text], or null when `line` does not open one. */
function orderedMatch(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return [line.slice(0, j), line.slice(j + 2)];
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWSCode(line.charCodeAt(j));
}

/**
 * Whether the character at `j` is escaped for a scan that starts at `from`: the backslashes directly
 * before it, counted back no further than `from`, have odd length in that span. A run pairs up from
 * where the scan meets it — each backslash but the last is followed by a backslash, which is escapable,
 * and the last is followed by `s[j]`, which every caller asks about only when it is escapable too — so
 * an odd span leaves its last backslash free to escape `s[j]`.
 */
function isEscapedAt(s, j, from) {
  let run = 0;
  for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) run++;
  return run % 2 === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    j = s.indexOf(what, j);
    if (j === -1) return -1;
    if (!isEscapedAt(s, j, from)) return j;
    j++;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    j = s.indexOf('*', j);
    if (j === -1) return -1;
    if (isEscapedAt(s, j, from)) {
      j++;
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j += 2;
      continue;
    }
    return j;
  }
}

const INLINE_SPECIAL_G = /[\\`*\[]/g;

/**
 * `s` rendered inline; `link(target)` is a link's href. The scan jumps from one special character to the
 * next on the regex engine instead of stepping over every plain character in this loop; the plain runs
 * between specials are escaped in bulk, and each special is decided exactly as a character-stepping scan
 * would decide it (a failed special is stepped over, 1 or 2 characters, and stays part of the plain run).
 */
export function inline(s, link) {
  let out = '';
  let i = 0;
  let plain = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL_G.lastIndex = i;
    const hit = INLINE_SPECIAL_G.exec(s);
    if (hit === null) break;
    i = hit.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)]) {
        if (i > plain) out += escapeHtml(s.slice(plain, i));
        out += escapeHtml(s[i + 1]);
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out += escapeHtml(s.slice(plain, i));
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) out += escapeHtml(s.slice(plain, i));
          out += '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>';
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) out += escapeHtml(s.slice(plain, i));
        out += '<em>' + inline(s.slice(i + 1, j), link) + '</em>';
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    // c === 91, the only other character the scan can land on.
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      if (i > plain) out += escapeHtml(s.slice(plain, i));
      out += '<a href="' + escapeHtml(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
      i = m + 1;
      plain = i;
    } else i++;
  }
  if (n > plain) out += escapeHtml(s.slice(plain, n));
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      // A space-leading line can only be blank or a paragraph: every block marker needs its marker at position 0.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        i++;
        let s = '<pre><code';
        if (fence !== '') s += ' class="language-' + escapeHtml(fence) + '"';
        s += '>';
        while (i < n && !isFenceClose(lines[i])) {
          s += escapeHtml(lines[i]);
          s += '\n';
          i++;
        }
        i++;
        s += '</code></pre>';
        blocks.push(s);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const bullet = bulletMatch(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const c = l.length === 0 ? -1 : l.charCodeAt(0);
          if (c === 45 || c === 42) {
            const m = bulletMatch(l);
            if (m !== null) {
              items.push(trimLine(m));
              i++;
              continue;
            }
          }
          if (c === 32 && isContinued(l)) {
            items[items.length - 1] += '\n' + trimLine(l);
            i++;
          } else break;
        }
        let s = '<ul>\n';
        for (let k = 0; k < items.length; k++) s += `<li>${inline(items[k], link)}</li>\n`;
        s += '</ul>';
        blocks.push(s);
        continue;
      }
    } else if (c0 === 62) {
      let kept = '';
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') kept = kept === '' ? t : kept + '\n' + t;
      }
      blocks.push(kept === '' ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept, link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedMatch(line);
      if (ordered !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const c = l.length === 0 ? -1 : l.charCodeAt(0);
          if (c >= 48 && c <= 57) {
            const m = orderedMatch(l);
            if (m !== null) {
              items.push(trimLine(m[1]));
              i++;
              continue;
            }
          }
          if (c === 32 && isContinued(l)) {
            items[items.length - 1] += '\n' + trimLine(l);
            i++;
          } else break;
        }
        const start = Number(ordered[0]);
        let s = (start !== 1 ? `<ol start="${start}">` : '<ol>') + '\n';
        for (let k = 0; k < items.length; k++) s += `<li>${inline(items[k], link)}</li>\n`;
        s += '</ol>';
        blocks.push(s);
        continue;
      }
    }
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) text += '\n' + trimLine(lines[i++]);
    const html = inline(text, link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Whether any non-root scope in the chain binds a case-level name: a loop variable named `site`, `tags`, `recent` or
 * `loop` would shadow the case-level value a cached template was rendered with, so such a scope must not use the cache. */
function scopeShadows(scope) {
  let s = scope;
  while (s !== null) {
    if (s.parent !== null) {
      const v = s.vars;
      if (Object.hasOwn(v, 'site') || Object.hasOwn(v, 'tags') || Object.hasOwn(v, 'recent') || Object.hasOwn(v, 'loop')) return true;
    }
    s = s.parent;
  }
  return false;
}

/**
 * `nodes` rendered in the scope chain (`{ vars, parent }`), appending to `out`. `ctx` holds the parsed templates
 * and the include depth. A for-loop reuses one scope object per execution: rendering is synchronous, so no value
 * it binds can be observed across iterations.
 */
export function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = {};
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          // The element first, then the loop record: as in the reference's object literal, a loop named `loop`
          // leaves `loop` bound to the loop record, not the element.
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined) break;
        const ci = ctx.constCache !== undefined ? ctx.constCache.get(n.name) : undefined;
        if (ci !== undefined && depth + 1 + ci.depth <= INCLUDE_DEPTH && !scopeShadows(scope)) {
          out.push(ci.text);
          break;
        }
        if (depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * A template's rendering depends only on the case-level values (`site`, `tags`, `recent`) and loop variables bound
 * from them, and how deep its include chain runs. Such a template renders the same string on every page of a case,
 * so it is rendered once per case and reused. The analysis is conservative: any path from another name, any include
 * of a template that is not itself constant, and any include cycle all make a template non-constant (a cycle's
 * rendering genuinely depends on the include depth, so it can never be cached).
 */
function analyzeNodes(templates, infoCache, nodes, bound) {
  let depth = 0;
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) return { ok: false, depth: Infinity };
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) return { ok: false, depth: Infinity };
      let r = analyzeNodes(templates, infoCache, n.then, bound);
      if (!r.ok) return r;
      depth = Math.max(depth, r.depth);
      if (n.else !== null) {
        r = analyzeNodes(templates, infoCache, n.else, bound);
        if (!r.ok) return r;
        depth = Math.max(depth, r.depth);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) return { ok: false, depth: Infinity };
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      const r = analyzeNodes(templates, infoCache, n.body, b2);
      if (!r.ok) return r;
      depth = Math.max(depth, r.depth);
    } else if (n.kind === 'include') {
      const sub = templateInfo(templates, infoCache, n.name);
      if (!sub.ok) return { ok: false, depth: Infinity };
      depth = Math.max(depth, 1 + sub.depth);
    }
  }
  return { ok: true, depth };
}

function templateInfo(templates, infoCache, name) {
  const cached = infoCache.get(name);
  if (cached !== undefined) {
    if (cached.state === 1) return { ok: false, depth: Infinity };
    return cached;
  }
  const nodes = templates.get(name);
  if (nodes === undefined) return { ok: false, depth: Infinity };
  const info = { ok: true, depth: 0, state: 1 };
  infoCache.set(name, info);
  const r = analyzeNodes(templates, infoCache, nodes, new Set(['site', 'tags', 'recent']));
  info.ok = r.ok;
  info.depth = r.depth;
  info.state = 2;
  return info;
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const slugCache = new Map();
  const slugOf = (name) => {
    let v = slugCache.get(name);
    if (v === undefined) {
      v = slugify(name);
      slugCache.set(name, v);
    }
    return v;
  };
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugOf(name)) && seen.add(slugOf(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));

  // A page as its layout reads it. A post's card is the one the lists already hold.
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // Templates that depend only on the case-level values are rendered once here, in ascending include depth so each
  // one's includes are already cached, and reused by every page.
  const infoCache = new Map();
  for (const name of templates.keys()) templateInfo(templates, infoCache, name);
  const constNames = [...infoCache.entries()].filter(([, info]) => info.ok).sort((a, b) => a[1].depth - b[1].depth);
  const constCache = new Map();
  const caseVars = { site, tags: allTags, recent };
  const constCtx = { templates, constCache };
  for (const [name] of constNames) {
    const out = [];
    renderNodes(templates.get(name), { vars: caseVars, parent: null }, constCtx, 0, out);
    constCache.set(name, { text: out.join(''), depth: infoCache.get(name).depth });
  }
  const ctx = { templates, constCache };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}
