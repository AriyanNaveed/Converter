// Rebuilds the list of video frames by walking the raw media data (mdat) when the MP4 index
// (moov) is gone. Samples in an MP4 are length-prefixed NAL units, so we can walk them one
// access unit at a time, skip over interleaved audio, and re-synchronise after gaps.

import { nalHeader, isVcl, isKey, isPrefix, isSuffix, parseSlice, slicePpsId, unescapeRbsp } from './codec.js';

const WINDOW = 16 << 20;
const MAX_NAL = 64 << 20;
const WEAK_DISTANCE = 4 << 20; // how far to look for a confirmed resync before accepting a lone keyframe
const NEED = 'need';

export class Reader {
  constructor(blob) { this.blob = blob; this.start = 0; this.buf = new Uint8Array(0); }
  get end() { return this.start + this.buf.length; }
  async load(pos, min = WINDOW) {
    const e = Math.min(this.blob.size, pos + Math.max(min, WINDOW));
    this.buf = new Uint8Array(await this.blob.slice(pos, e).arrayBuffer());
    this.start = pos;
  }
}

const readLen = (b, i, ls) => {
  let L = 0;
  for (let k = 0; k < ls; k++) L = L * 256 + b[i + k];
  return L;
};

// Try to parse one access unit starting at p. Returns NEED, null, or { end, info, key }.
function probeAU(st, rd, p, E) {
  const b = rd.buf, base = rd.start, bufEnd = rd.end, ls = st.lengthSize, codec = st.codec;
  const hb = codec === 'avc' ? 1 : 2;
  const aud = codec === 'avc' ? 9 : 35;
  let q = p, first = null, nals = 0;
  const rbsp = (i, L, n) => unescapeRbsp(b, i, Math.min(i + n, i - hb + L, b.length));
  for (;;) {
    if (q >= E) break;
    if (q + ls + hb + 1 > bufEnd) { if (bufEnd < E) return NEED; break; }
    const i = q - base;
    const L = readLen(b, i, ls);
    if (L < hb + 1 || L > MAX_NAL || q + ls + L > E) break;
    const h = nalHeader(codec, b[i + ls], b[i + ls + 1]);
    if (!h) break;
    const vcl = isVcl(codec, h.type);
    const firstSlice = vcl && (b[i + ls + hb] & 0x80) !== 0;
    if (first) {
      if (isPrefix(codec, h.type) || firstSlice) break; // next access unit starts here
      if (vcl) {
        if (h.type !== first.type) break;
        if (q + ls + hb + 16 > bufEnd && bufEnd < E) return NEED;
        if (slicePpsId(st, h, rbsp(i + ls + hb, L, 16)) !== first.ppsId) break;
      } else if (!isSuffix(codec, h.type)) break;
    } else if (vcl) {
      if (!firstSlice) break;
      if (q + ls + hb + 48 > bufEnd && bufEnd < E) return NEED;
      first = parseSlice(st, h, rbsp(i + ls + hb, L, 48));
      if (!first) break;
    } else if (!isPrefix(codec, h.type) || (nals > 0 && h.type === aud)) {
      break;
    }
    nals++;
    q += ls + L;
  }
  if (!first) return null;
  return { end: q, info: first, key: isKey(codec, first.type) };
}

// Sequence state used to check that a candidate frame continues the stream we were walking.
const startState = (info) => ({ fn: info.ref ? info.frameNum : 0, lsb: info.lsb });
const advance = (s, info) => ({ fn: info.ref ? info.frameNum : s.fn, lsb: info.lsb });
function pocClose(s, info) {
  const max = 1 << info.sps.log2MaxPocLsb;
  let d = (((info.lsb - s.lsb) % max) + max) % max;
  if (d > max / 2) d -= max;
  return d !== 0 && Math.abs(d) <= Math.min(64, max / 4);
}
function consistent(st, s, info) {
  if (!s) return false;
  if (st.codec === 'avc') {
    if (info.idr) return true;
    if (info.frameNum !== (s.fn + 1) % (1 << info.sps.log2MaxFrameNum)) return false;
    return info.sps.pocType !== 0 || pocClose(s, info);
  }
  if (isKey('hevc', info.type)) return true;
  return pocClose(s, info);
}

export async function scanFrames(blob, st, S, E, onProgress) {
  const rd = new Reader(blob);
  const frames = [];
  let state = null, maxKey = 0, maxNon = 0, lastReport = 0;
  const ls = st.lengthSize;

  const sizeOk = (au, q) => {
    const n = au.end - q;
    return au.key ? n <= Math.max(8 << 20, maxKey * 4) : n <= Math.max(2 << 20, maxNon * 6);
  };

  async function probeAt(q) {
    if (q >= E) return null;
    let grow = WINDOW;
    if (q < rd.start || q + 64 > rd.end) await rd.load(q);
    for (;;) {
      const r = probeAU(st, rd, q, E);
      if (r !== NEED) return r;
      grow = rd.start === q ? grow * 2 : WINDOW;
      await rd.load(q, grow);
    }
  }

  function accept(q, au, discont) {
    const size = au.end - q;
    frames.push({ off: q, size, key: au.key, info: au.info, discont });
    if (au.key) maxKey = Math.max(maxKey, size); else maxNon = Math.max(maxNon, size);
    state = discont || !state ? startState(au.info) : advance(state, au.info);
    if (onProgress && q - lastReport > (8 << 20)) { lastReport = q; onProgress((q - S) / (E - S)); }
  }

  // Search forward from `from` for the start of the next access unit that continues `seq`.
  // A keyframe is accepted once the frame after it (possibly past an audio gap) is found too.
  async function resync(from, seq = state, limit = Infinity, confirmKeys = true) {
    let weak = null;
    let q = from;
    const stop = Math.min(E, from + limit);
    while (q < stop) {
      if (q < rd.start || q + 64 > rd.end) {
        if (rd.end >= E && q >= rd.start) { /* tail of range already loaded */ } else await rd.load(q);
      }
      const b = rd.buf, base = rd.start;
      const lim = Math.min(rd.end < E ? rd.end - 64 : E, stop);
      let hit = null;
      for (; q < lim; q++) {
        const i = q - base;
        if (ls === 4 && (b[i] !== 0 || b[i + 1] > 3)) continue;
        if (!nalHeader(st.codec, b[i + ls], b[i + ls + 1])) continue;
        hit = probeAU(st, rd, q, E);
        if (hit) break;
      }
      if (q >= lim) { if (lim >= stop) break; continue; }
      const au = hit === NEED ? await probeAt(q) : hit;
      if (au && sizeOk(au, q)) {
        if (!au.key && consistent(st, seq, au.info)) return { q, au, discont: false };
        if (au.key) {
          const discont = !consistent(st, seq, au.info);
          if (!confirmKeys) return { q, au, discont };
          const s0 = startState(au.info);
          const nxt = await probeAt(au.end);
          const ok = (nxt && consistent(st, s0, nxt.info)) || (await resync(au.end, s0, 1 << 20, false));
          if (ok) return { q, au, discont };
          if (!weak) weak = { q, au, discont };
        }
      }
      if (weak && q - weak.q > WEAK_DISTANCE) return weak;
      q++;
    }
    return weak;
  }

  let r = await resync(S);
  while (r) {
    // only start decoding at a keyframe
    if (!frames.length && !r.au.key) { r = await resync(r.q + 1); continue; }
    accept(r.q, r.au, r.discont || !frames.length);
    let p = r.au.end;
    r = null;
    for (;;) {
      const au = await probeAt(p);
      if (!au || !sizeOk(au, p)) break;
      if (!consistent(st, state, au.info)) {
        const nxt = await probeAt(au.end);
        if (!nxt) break;
      }
      accept(p, au, false);
      p = au.end;
    }
    if (p >= E) break;
    r = await resync(p);
  }
  onProgress?.(1);
  return frames;
}

// Assign decode/presentation timestamps from picture order counts so B-frames play in order.
export function buildTimeline(st, frames, delta) {
  const kept = [];
  let skipRasl = false;
  for (const f of frames) {
    const t = f.info.type;
    if (st.codec === 'hevc') {
      if (t >= 16 && t <= 21) skipRasl = t <= 18 || (t === 21 && (f.discont || !kept.length));
      else if ((t === 8 || t === 9) && skipRasl) continue;
    }
    kept.push(f);
  }

  const poc = new Array(kept.length);
  const epoch = new Array(kept.length);
  let ep = -1, msb = 0, prevLsb = 0, prevMsb = 0, idx = 0;
  kept.forEach((f, i) => {
    const info = f.info, t = info.type;
    if (st.codec === 'avc') {
      if (info.idr || f.discont) { ep++; prevMsb = 0; prevLsb = 0; idx = 0; }
      if (info.sps.pocType === 0) {
        const max = 1 << info.sps.log2MaxPocLsb;
        if (info.lsb < prevLsb && prevLsb - info.lsb >= max / 2) msb = prevMsb + max;
        else if (info.lsb > prevLsb && info.lsb - prevLsb > max / 2) msb = prevMsb - max;
        else msb = prevMsb;
        poc[i] = msb + info.lsb;
        if (info.ref) { prevMsb = msb; prevLsb = info.lsb; }
      } else {
        poc[i] = idx++;
      }
    } else {
      const max = 1 << info.sps.log2MaxPocLsb;
      const irap = t >= 16 && t <= 21;
      if (irap && (t <= 20 || f.discont || i === 0)) { ep++; msb = 0; }
      else if (info.lsb < prevLsb && prevLsb - info.lsb >= max / 2) msb = prevMsb + max;
      else if (info.lsb > prevLsb && info.lsb - prevLsb > max / 2) msb = prevMsb - max;
      else msb = prevMsb;
      poc[i] = msb + info.lsb;
      const nonRef = t <= 14 && t % 2 === 0;
      if (info.tid === 0 && !(t >= 6 && t <= 9) && !nonRef) { prevMsb = msb; prevLsb = info.lsb; }
    }
    epoch[i] = ep;
  });

  // presentation index = first decode index of the epoch + rank of the POC inside it
  const pts = new Array(kept.length);
  for (let s = 0; s < kept.length;) {
    let e = s;
    while (e < kept.length && epoch[e] === epoch[s]) e++;
    const order = [];
    for (let i = s; i < e; i++) order.push(i);
    order.sort((a, b) => poc[a] - poc[b] || a - b);
    order.forEach((i, rank) => { pts[i] = s + rank; });
    s = e;
  }
  let shift = 0;
  kept.forEach((_, i) => { shift = Math.max(shift, i - pts[i]); });
  const samples = kept.map((f, i) => ({
    off: f.off, size: f.size, key: f.key, dur: delta, cto: (pts[i] - i + shift) * delta,
  }));
  return { samples, mediaTime: shift * delta };
}
