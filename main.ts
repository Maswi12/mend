// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
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

// ---- Files as lines (SPEC.md section 3) ----

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function toModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---- Matching lines (SPEC.md section 5) ----

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** The first tier at which O occurs in lines at or after `from`, with every occurrence's 0-based start. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!lineEq(lines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A parsed hunk/chunk body: context, old, new and `\` marker lines in order. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  emptyLine?: boolean;
}

/**
 * The lines a matched body writes: context lines are the file's own matched lines; at tier 2 every other new
 * line that starts with O's first line's indentation P has P replaced by the file's first matched line's F.
 */
function buildWritten(items: BodyItem[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  let oPos = 0;
  const f = o.length > 0 ? leadingWs(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  for (const it of items) {
    if (it.kind === 'del') {
      oPos += 1;
    } else if (it.kind === 'ctx') {
      out.push(fileLines[pos + oPos]!);
      oPos += 1;
    } else if (it.kind === 'add') {
      let t = it.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

function bodyOld(items: BodyItem[]): string[] {
  return items.filter((it) => it.kind === 'ctx' || it.kind === 'del').map((it) => it.text);
}

/** True when a `\` line follows the body's last context or `+` line. */
function backslashAfterLastWritten(items: BodyItem[]): boolean {
  let last = -1;
  items.forEach((it, i) => {
    if (it.kind === 'ctx' || it.kind === 'add') last = i;
  });
  return last >= 0 && items[last + 1]?.kind === 'bs';
}

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

// ---- Unified diffs (SPEC.md section 6) ----

interface UHunk {
  a: number;
  items: BodyItem[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld?: string;
  hdrNew?: string;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function newUSection(): USection {
  return { gitOld: null, gitNew: null, hasPair: false, newFile: false, delFile: false, hunks: [] };
}

function headerPath(raw: string): string {
  let t = raw;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (t !== '/dev/null' && (t.startsWith('a/') || t.startsWith('b/'))) t = t.slice(2);
  return t;
}

const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inBody = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (isDiffGitLine(line)) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newUSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inBody = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      if (cur === null || inBody || cur.hasPair) {
        cur = newUSection();
        sections.push(cur);
        inBody = false;
      }
      cur.hdrOld = headerPath(line.slice(4));
      cur.hdrNew = headerPath(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && !inBody) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const items: BodyItem[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (isDiffGitLine(bl)) break;
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '') {
          items.push({ kind: 'ctx', text: '', emptyLine: true });
          i += 1;
        } else if (bl[0] === ' ') {
          items.push({ kind: 'ctx', text: bl.slice(1) });
          i += 1;
        } else if (bl[0] === '-') {
          items.push({ kind: 'del', text: bl.slice(1) });
          i += 1;
        } else if (bl[0] === '+') {
          items.push({ kind: 'add', text: bl.slice(1) });
          i += 1;
        } else if (bl[0] === '\\') {
          items.push({ kind: 'bs', text: '' });
          i += 1;
        } else break;
      }
      while (items.length > 0 && items[items.length - 1]!.emptyLine) items.pop();
      cur.hunks.push({ a, items });
      inBody = true;
      continue;
    }
    if (cur !== null && !inBody) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One hunk applied to the model; returns the change in line count. Throws Fail('no-match'). */
function applyUnifiedHunk(model: FileModel, hunk: UHunk, d: number, strict: boolean, path: string): number {
  const o = bodyOld(hunk.items);
  const hasWritten = hunk.items.some((it) => it.kind === 'ctx' || it.kind === 'add');
  const bsAfter = backslashAfterLastWritten(hunk.items);
  if (o.length === 0) {
    const pos = Math.max(0, Math.min(hunk.a + d, model.lines.length));
    const written = buildWritten(hunk.items, model.lines, pos, 0, o);
    const atEnd = pos === model.lines.length;
    model.lines.splice(pos, 0, ...written);
    if (atEnd && hasWritten) model.final = !bsAfter;
    return written.length;
  }
  const found = findTier(model.lines, o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const written = buildWritten(hunk.items, model.lines, best, found.tier, o);
  const atEnd = best + o.length === model.lines.length;
  model.lines.splice(best, o.length, ...written);
  if (atEnd && hasWritten) model.final = !bsAfter;
  return written.length - o.length;
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.hdrOld !== undefined ? sec.hdrOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld!;
  const newP = sec.hdrNew !== undefined ? sec.hdrNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew !== null ? sec.gitNew : oldP;
  const isCreate = sec.newFile || oldP === '/dev/null';
  const isDelete = !isCreate && (sec.delFile || newP === '/dev/null');
  if (isCreate) {
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const fileLines: string[] = [];
      let lastH = -1;
      let lastI = -1;
      sec.hunks.forEach((h, hi) => {
        h.items.forEach((it, ii) => {
          if (it.kind === 'add') {
            fileLines.push(it.text);
            lastH = hi;
            lastI = ii;
          }
        });
      });
      let finalBreak = true;
      if (lastH >= 0 && sec.hunks[lastH]!.items[lastI + 1]?.kind === 'bs') finalBreak = false;
      tree.now.set(newP, fileLines.length === 0 ? '' : fileLines.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  const isMove = oldP !== newP;
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = toModel(before);
    let d = 0;
    for (const hunk of sec.hunks) d += applyUnifiedHunk(model, hunk, d, strict, oldP);
    const text = fromModel(model);
    if (isMove) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const blockPath = path;
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldLines.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const model = toModel(before);
      const found = findTier(model.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.positions.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = found.positions[0]!;
      const f = leadingWs(model.lines[pos]!);
      const p = leadingWs(oldLines[0]!);
      const written = newLines.map((t) => (found.tier === 2 && t.trim() !== '' && t.startsWith(p) ? f + t.slice(p.length) : t));
      model.lines.splice(pos, oldLines.length, ...written);
      tree.now.set(blockPath, fromModel(model));
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines: string[];
  /** Parallel to addLines: true when the line came from a blank patch line (strippable at a section's end). */
  addBlank: boolean[];
  moveTo?: string;
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

const isVHeader = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      lastIdx = j;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = firstIdx + 1;
  const end = lastIdx;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V_ADD)) {
      const sec: VSection = { kind: 'add', path: line.slice(V_ADD.length).trim(), line: i + 1, addLines: [], addBlank: [], chunks: [] };
      i += 1;
      while (i < end) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          sec.addLines.push(l.slice(1));
          sec.addBlank.push(false);
          i += 1;
        } else if (l === '') {
          sec.addLines.push('');
          sec.addBlank.push(true);
          i += 1;
        } else break;
      }
      while (sec.addLines.length > 0 && sec.addBlank[sec.addBlank.length - 1]) {
        sec.addLines.pop();
        sec.addBlank.pop();
      }
      sections.push(sec);
      continue;
    }
    if (line.startsWith(V_DEL)) {
      sections.push({ kind: 'delete', path: line.slice(V_DEL.length).trim(), line: i + 1, addLines: [], addBlank: [], chunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith(V_UPD)) {
      const sec: VSection = { kind: 'update', path: line.slice(V_UPD.length).trim(), line: i + 1, addLines: [], addBlank: [], chunks: [] };
      i += 1;
      if (i < end && lines[i]!.startsWith(V_MOVE)) {
        sec.moveTo = lines[i]!.slice(V_MOVE.length).trim();
        i += 1;
      }
      let chunk: VChunk | null = null;
      const closeChunk = (): void => {
        if (chunk !== null) {
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < end) {
        const l = lines[i]!;
        if (isVHeader(l)) break;
        if (l.startsWith('@@')) {
          closeChunk();
          const a = l.slice(2).trim();
          chunk = { anchor: a === '' ? null : a, eof: false, items: [] };
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          closeChunk();
          i += 1;
          continue;
        }
        const c = l[0];
        if (l === '' || c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            if (l === '' && sec.chunks.length > 0) {
              i += 1;
              continue;
            }
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            chunk = { anchor: null, eof: false, items: [] };
          }
          if (l === '') chunk.items.push({ kind: 'ctx', text: '', emptyLine: true });
          else if (c === ' ') chunk.items.push({ kind: 'ctx', text: l.slice(1) });
          else if (c === '-') chunk.items.push({ kind: 'del', text: l.slice(1) });
          else chunk.items.push({ kind: 'add', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk !== undefined && !lastChunk.eof) {
        // Blank lines at the end of a section are not part of it: drop trailing context lines
        // that came from blank patch lines (empty, or only whitespace after the leading space).
        while (lastChunk.items.length > 0) {
          const it = lastChunk.items[lastChunk.items.length - 1]!;
          if (it.kind === 'ctx' && it.text.trim() === '') lastChunk.items.pop();
          else break;
        }
      }
      sec.chunks = sec.chunks.filter((ch) => ch.items.length > 0 || ch.anchor !== null || ch.eof);
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.line}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  const p = sec.path;
  if (sec.kind === 'add') {
    const fileLines = sec.addLines;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = toModel(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(model.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const o = bodyOld(ch.items);
      if (o.length === 0) {
        const written = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...written);
        cursor = pos + written.length;
      } else {
        let found: { tier: number; positions: number[] } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const positions: number[] = [];
          for (let k = cursor; k + o.length <= model.lines.length; k++) {
            if (ch.eof && k + o.length !== model.lines.length) continue;
            let ok = true;
            for (let j = 0; j < o.length; j++) {
              if (!lineEq(model.lines[k + j]!, o[j]!, tier)) {
                ok = false;
                break;
              }
            }
            if (ok) positions.push(k);
          }
          if (positions.length > 0) {
            found = { tier, positions };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const written = buildWritten(ch.items, model.lines, pos, found.tier, o);
        model.lines.splice(pos, o.length, ...written);
        cursor = pos + written.length;
      }
    }
    const text = fromModel(model);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, text);
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- JSON edits (SPEC.md section 9) ----

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
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
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const movePairs: [string, string][] = [];
  for (const [o, nw] of tree.moves) {
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(nw) === null && finalOf(nw) !== null) {
      if (!movePairs.some(([a, b]) => a === o && b === nw)) movePairs.push([o, nw]);
    }
  }
  const consumed = new Set<string>();
  const entries: { key: string; line: string }[] = [];
  for (const [o, nw] of movePairs) {
    entries.push({ key: nw, line: `R ${o} -> ${nw}` });
    consumed.add(o);
    consumed.add(nw);
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of tree.now.keys()) {
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
