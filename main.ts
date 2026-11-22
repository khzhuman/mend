// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` output line (section 2). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file's text as lines, its line break, and whether it ends with one (section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where pat occurs in lines at tier, from `from` on; with `eof` only ones ending at the last line. */
function occurrences(lines: string[], pat: string[], tier: number, from: number, eof: boolean): number[] {
  const out: number[] = [];
  const np = pat.map((l) => normLine(l, tier));
  for (let i = from; i + pat.length <= lines.length; i++) {
    if (eof && i + pat.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j]!, tier) !== np[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) at which pat occurs, with its positions. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0, eof = false): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, pat, t, from, eof);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier with one (a V4A anchor). */
function findSingle(lines: string[], one: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(one, t)) return i;
    }
  }
  return -1;
}

/**
 * The lines replacing a match: a context line is written as the file's own matched line, and at tier 2
 * every other line is re-indented from the old block's leading whitespace to the file's (section 5).
 * nCtx[i] is the index into O of N's line i when it is a context line, else null.
 */
function buildReplacement(lines: string[], at: number, o: string[], n: string[], nCtx: (number | null)[], tier: number): string[] {
  const f = leadingWs(lines[at] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((line, i) => {
    const oi = nCtx[i] ?? null;
    if (oi !== null) return lines[at + oi]!;
    if (tier === 2 && line !== '' && !/^[ \t]*$/.test(line) && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

/** A hunk or chunk body, read from its raw lines. */
interface BodyLines {
  o: string[];
  n: string[];
  nCtx: (number | null)[];
  /** The `+` lines, in body order (what a creation is made of). */
  plus: string[];
  /** A `\` line follows the body's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the body's last `+` line. */
  noEolPlus: boolean;
}

function parseBody(raw: string[]): BodyLines {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  const plus: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k]![0];
    if (c === ' ' || c === '+') lastCtxPlus = k;
    if (c === '+') lastPlus = k;
  }
  for (let k = 0; k < raw.length; k++) {
    const line = raw[k]!;
    const c = line[0];
    if (c === ' ') { nCtx.push(o.length); o.push(line.slice(1)); n.push(line.slice(1)); }
    else if (c === '-') o.push(line.slice(1));
    else if (c === '+') { nCtx.push(null); n.push(line.slice(1)); plus.push(line.slice(1)); }
    else if (line === '') { nCtx.push(o.length); o.push(''); n.push(''); }
    // a `\` line refers to the body line before it and adds no line
  }
  const follows = (idx: number): boolean => idx >= 0 && raw[idx + 1] !== undefined && raw[idx + 1]![0] === '\\';
  return { o, n, nCtx, plus, noEol: follows(lastCtxPlus), noEolPlus: follows(lastPlus) };
}

interface Hunk {
  a: number;
  body: BodyLines;
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function freshSection(): UniSection {
  return { pairOld: null, pairNew: null, hasPair: false, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [] };
}

/** A `---`/`+++` path: one leading `a/` or `b/` removed, `/dev/null` meaning no file. */
function uniPath(raw: string): string | null {
  let p = raw;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

/** A `---`/`+++` path: the text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** Apply a section's hunks in order to a file's text (section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitText(text);
  let d = 0;
  for (const h of hunks) {
    const b = h.body;
    if (b.o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const wasEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...b.n);
      if (wasEnd) f.final = !b.noEol;
      d += b.n.length;
      continue;
    }
    const found = findTier(f.lines, b.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const repl = buildReplacement(f.lines, best, b.o, b.n, b.nCtx, found.tier);
    const toEnd = best + b.o.length === f.lines.length;
    f.lines.splice(best, b.o.length, ...repl);
    if (toEnd) f.final = !b.noEol;
    d += b.n.length - b.o.length;
  }
  return joinText(f);
}

/** One unified-diff section as one edit (section 6). */
function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.pairOld : sec.renameFrom ?? sec.diffOld;
  const newP = sec.hasPair ? sec.pairNew : sec.renameTo ?? sec.diffNew;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = newP === null || sec.deletedFile;
  const kind = isCreate ? 'create' : isDelete ? 'delete' : oldP !== newP ? 'move' : 'change';
  return (tree) => {
    const paths: string[] = [];
    if (oldP !== null) paths.push(oldP);
    if (newP !== null && newP !== oldP) paths.push(newP);
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'create') {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        if (h.body.plus.length > 0) noEol = h.body.noEolPlus;
        plus.push(...h.body.plus);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const op = oldP!;
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const out = applyHunks(text, sec.hunks, strict, op);
    if (kind === 'move') {
      tree.now.set(newP!, out);
      tree.now.set(op, null);
      tree.moves.push([op, newP!]);
    } else {
      tree.now.set(op, out);
    }
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';

/** Read a patch as unified diffs: sections of hunks, each section one edit (section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHunk: Hunk | null = null;
  let body: string[] = [];
  const endBody = (): void => {
    if (curHunk !== null) {
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      curHunk.body = parseBody(body);
      body = [];
      curHunk = null;
    }
  };
  const endSection = (): void => {
    endBody();
    if (cur !== null) {
      sections.push(cur);
      cur = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
        endSection();
        continue;
      }
      if (isBodyLine(line)) { body.push(line); i++; continue; }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endSection();
      cur = freshSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = uniPath(headerPath(line));
      const newP = uniPath(headerPath(lines[i + 1]!));
      if (cur !== null && cur.hunks.length === 0) {
        // Still in this section's header: the pair names its paths, it starts no new section.
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      } else {
        endSection();
        cur = freshSection();
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: Number(m[1]), body: { o: [], n: [], nCtx: [], plus: [], noEol: false, noEolPlus: false } };
      cur.hunks.push(curHunk);
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) { cur.renameFrom = line.slice('rename from '.length).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { cur.renameTo = line.slice('rename to '.length).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { cur.newFile = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.deletedFile = true; i++; continue; }
      i++;
      continue;
    }
    i++;
  }
  endSection();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as one edit (section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitText(text);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const nCtx: (number | null)[] = newLines.map(() => null);
    const repl = buildReplacement(f.lines, at, oldLines, newLines, nCtx, found.tier);
    f.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, joinText(f));
  };
}

/** Read a patch as SEARCH/REPLACE blocks, each block one edit (section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { si = j; break; }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${si + 1}`);
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    edits.push(srEdit(path, lines.slice(si + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  body: BodyLines;
  eof: boolean;
}

/** One V4A Update File section as one edit (section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitText(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const idx = findSingle(f.lines, ch.anchor, strict, cursor);
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const b = ch.body;
      if (b.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...b.n);
        cursor = at + b.n.length;
        continue;
      }
      const found = findTier(f.lines, b.o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const at = found.occ[0]!;
      const repl = buildReplacement(f.lines, at, b.o, b.n, b.nCtx, found.tier);
      f.lines.splice(at, b.o.length, ...repl);
      cursor = at + repl.length;
    }
    const out = joinText(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a patch as a V4A patch: sections between Begin and End Patch, each one edit (section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSecStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (!isSecStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const headerIdx = i;
    let j = i + 1;
    while (j < last && !isSecStart(lines[j]!)) j++;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${headerIdx + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (raw.length > 0) throw new Exit2(`error: parse ${headerIdx + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const flush = (): void => {
        if (cur !== null) {
          chunks.push({ anchor: cur.anchor, body: parseBody(cur.body), eof: cur.eof });
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        const no = headerIdx + 2 + k;
        if (l.startsWith('@@')) {
          flush();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          flush();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(l);
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const doneMoves = tree.moves.filter(([o, n]) => tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null);
  const movedOld = new Set(doneMoves.map(([o]) => o));
  const movedNew = new Set(doneMoves.map(([, n]) => n));
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of doneMoves) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of changed) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
