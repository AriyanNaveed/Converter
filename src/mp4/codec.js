// H.264 / HEVC bitstream helpers: parameter sets, slice headers, NAL validation and
// building codec config boxes. Only the fields needed to rebuild an MP4 index are parsed.

export function unescapeRbsp(b, start, end) {
  const out = new Uint8Array(Math.max(0, end - start));
  let n = 0, zeros = 0;
  for (let i = start; i < end; i++) {
    const v = b[i];
    if (zeros >= 2 && v === 3) { zeros = 0; continue; }
    out[n++] = v;
    zeros = v === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

class Bits {
  constructor(b) { this.b = b; this.p = 0; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.p >> 3];
      if (byte === undefined) throw new RangeError('eof');
      v = v * 2 + ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v;
  }
  ue() {
    let z = 0;
    while (this.u(1) === 0) if (++z > 31) throw new RangeError('bad ue');
    return z ? 2 ** z - 1 + this.u(z) : 0;
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
  skip(n) { this.p += n; }
}

const AVC_HIGH = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export function parseAvcSps(nal) {
  const r = new Bits(unescapeRbsp(nal, 1, nal.length));
  const profile = r.u(8); r.u(8); r.u(8);
  const id = r.ue();
  let chroma = 1, sep = 0;
  if (AVC_HIGH.has(profile)) {
    chroma = r.ue();
    if (chroma === 3) sep = r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  const log2MaxFrameNum = r.ue() + 4;
  const pocType = r.ue();
  let log2MaxPocLsb = 0;
  if (pocType === 0) log2MaxPocLsb = r.ue() + 4;
  else if (pocType === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  r.ue(); r.u(1);
  const wMbs = r.ue() + 1, hMap = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
  const mono = chroma === 0 || sep;
  const cux = mono ? 1 : chroma === 3 ? 1 : 2;
  const cuy = (mono ? 1 : chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  const width = wMbs * 16 - cux * (cl + cr);
  const height = (2 - frameMbsOnly) * hMap * 16 - cuy * (ct + cb);
  if (log2MaxFrameNum > 16 || log2MaxPocLsb > 16 || width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new RangeError('implausible SPS');
  }
  // VUI timing → frame rate (optional)
  let timing = null;
  try {
    if (r.u(1)) {
      if (r.u(1) && r.u(8) === 255) r.skip(32);
      if (r.u(1)) r.u(1);
      if (r.u(1)) { r.skip(4); if (r.u(1)) r.skip(24); }
      if (r.u(1)) { r.ue(); r.ue(); }
      if (r.u(1)) {
        const units = r.u(32), scale = r.u(32);
        if (units > 0 && scale > 0 && scale / (2 * units) <= 240 && scale / (2 * units) >= 1) timing = { units, scale };
      }
    }
  } catch { /* no VUI */ }
  return { id, profile, sep, log2MaxFrameNum, pocType, log2MaxPocLsb, frameMbsOnly, width, height, timing };
}

export function parseAvcPps(nal) {
  const r = new Bits(unescapeRbsp(nal, 1, Math.min(nal.length, 16)));
  return { id: r.ue(), spsId: r.ue() };
}

export function parseHevcSps(nal) {
  const rb = unescapeRbsp(nal, 2, nal.length);
  const r = new Bits(rb);
  r.u(4);
  const maxSub = r.u(3);
  const nested = r.u(1);
  r.skip(88); r.u(8);
  const sp = [], sl = [];
  for (let i = 0; i < maxSub; i++) { sp[i] = r.u(1); sl[i] = r.u(1); }
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSub; i++) { if (sp[i]) r.skip(88); if (sl[i]) r.skip(8); }
  const id = r.ue();
  const chroma = r.ue();
  const sep = chroma === 3 ? r.u(1) : 0;
  let width = r.ue(), height = r.ue();
  if (r.u(1)) {
    const sw = chroma === 1 || chroma === 2 ? 2 : 1, sh = chroma === 1 ? 2 : 1;
    const l = r.ue(), rr = r.ue(), t = r.ue(), bb = r.ue();
    width -= sw * (l + rr); height -= sh * (t + bb);
  }
  const bdLuma = r.ue() + 8, bdChroma = r.ue() + 8;
  const log2MaxPocLsb = r.ue() + 4;
  if (log2MaxPocLsb > 16 || width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new RangeError('implausible SPS');
  }
  return { id, chroma, sep, width, height, bdLuma, bdChroma, log2MaxPocLsb, maxSub, nested, ptl: rb.subarray(1, 13) };
}

export function parseHevcPps(nal) {
  const r = new Bits(unescapeRbsp(nal, 2, Math.min(nal.length, 16)));
  const id = r.ue(), spsId = r.ue();
  r.u(1);
  const outputFlag = r.u(1);
  const extraBits = r.u(3);
  return { id, spsId, outputFlag, extraBits };
}

// ---- codec config (avcC / hvcC payloads) ----

export function parseAvcC(d) {
  const lengthSize = (d[4] & 3) + 1;
  let p = 6;
  const sps = [], pps = [];
  for (let i = 0, n = d[5] & 31; i < n; i++) { const l = (d[p] << 8) | d[p + 1]; sps.push(d.subarray(p + 2, p + 2 + l)); p += 2 + l; }
  for (let i = 0, n = d[p++]; i < n; i++) { const l = (d[p] << 8) | d[p + 1]; pps.push(d.subarray(p + 2, p + 2 + l)); p += 2 + l; }
  return { lengthSize, sps, pps, vps: [] };
}

export function parseHvcC(d) {
  const lengthSize = (d[21] & 3) + 1;
  let p = 23;
  const out = { lengthSize, vps: [], sps: [], pps: [] };
  for (let i = 0, n = d[22]; i < n; i++) {
    const type = d[p] & 0x3f;
    const cnt = (d[p + 1] << 8) | d[p + 2];
    p += 3;
    for (let j = 0; j < cnt; j++) {
      const l = (d[p] << 8) | d[p + 1];
      const nal = d.subarray(p + 2, p + 2 + l);
      p += 2 + l;
      if (type === 32) out.vps.push(nal); else if (type === 33) out.sps.push(nal); else if (type === 34) out.pps.push(nal);
    }
  }
  return out;
}

// Decoder state built from parameter sets: { codec, lengthSize, sps: Map, pps: Map, width, height }
export function makeCodecState(codec, cfg) {
  const st = { codec, lengthSize: cfg.lengthSize, sps: new Map(), pps: new Map(), width: 0, height: 0 };
  for (const n of cfg.sps) {
    const s = codec === 'avc' ? parseAvcSps(n) : parseHevcSps(n);
    st.sps.set(s.id, s);
    if (!st.width) { st.width = s.width; st.height = s.height; }
  }
  for (const n of cfg.pps) {
    const p = codec === 'avc' ? parseAvcPps(n) : parseHevcPps(n);
    if (st.sps.has(p.spsId)) st.pps.set(p.id, p);
  }
  if (!st.sps.size || !st.pps.size) throw new Error('Codec config has no usable SPS/PPS.');
  return st;
}

// ---- sample entry handling ----

const VISUAL_ENTRY_HDR = 86; // box header + VisualSampleEntry fields
const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

export const AVC_ENTRIES = new Set(['avc1', 'avc3']);
export const HEVC_ENTRIES = new Set(['hvc1', 'hev1']);

// Turn a raw visual sample entry box into { entry, codec, state }.
export function codecFromEntry(entry) {
  const type = fourcc(entry, 4);
  const codec = AVC_ENTRIES.has(type) ? 'avc' : HEVC_ENTRIES.has(type) ? 'hevc' : null;
  if (!codec) throw new Error(`Unsupported video codec "${type}" (only H.264 and HEVC can be rebuilt).`);
  const want = codec === 'avc' ? 'avcC' : 'hvcC';
  let p = VISUAL_ENTRY_HDR;
  while (p + 8 <= entry.length) {
    const sz = be32(entry, p);
    if (sz < 8 || p + sz > entry.length) break;
    if (fourcc(entry, p + 4) === want) {
      const d = entry.subarray(p + 8, p + sz);
      const cfg = codec === 'avc' ? parseAvcC(d) : parseHvcC(d);
      return { entry, codec, state: makeCodecState(codec, cfg) };
    }
    p += sz;
  }
  throw new Error(`Sample entry has no ${want} box.`);
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u16b = (v) => new Uint8Array([(v >> 8) & 255, v & 255]);
const u32b = (v) => new Uint8Array([(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
const str = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const mkbox = (type, ...parts) => { const body = concat(parts); return concat([u32b(body.length + 8), str(type), body]); };

function visualEntry(type, width, height, configBox) {
  const name = new Uint8Array(32);
  return mkbox(
    type,
    new Uint8Array(6), u16b(1), new Uint8Array(16), u16b(width), u16b(height),
    u32b(0x00480000), u32b(0x00480000), u32b(0), u16b(1), name, u16b(0x18), u16b(0xffff),
    configBox,
  );
}

// Build an avc1 / hvc1 sample entry from in-band parameter sets.
export function buildEntry(codec, sets) {
  const st = makeCodecState(codec, { lengthSize: 4, ...sets });
  if (codec === 'avc') {
    const sps = sets.sps[0];
    const parts = [new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe0 | sets.sps.length])];
    for (const s of sets.sps) parts.push(u16b(s.length), s);
    parts.push(new Uint8Array([sets.pps.length]));
    for (const p of sets.pps) parts.push(u16b(p.length), p);
    return { entry: visualEntry('avc1', st.width, st.height, mkbox('avcC', ...parts)), codec, state: st };
  }
  const s = parseHevcSps(sets.sps[0]);
  const arrays = [[32, sets.vps], [33, sets.sps], [34, sets.pps]];
  const parts = [
    new Uint8Array([1]), s.ptl,
    new Uint8Array([0xf0, 0x00, 0xfc, 0xfc | s.chroma, 0xf8 | (s.bdLuma - 8), 0xf8 | (s.bdChroma - 8), 0, 0,
      ((s.maxSub + 1) << 3) | (s.nested << 2) | 3, arrays.length]),
  ];
  for (const [t, list] of arrays) {
    parts.push(new Uint8Array([0x80 | t]), u16b(list.length));
    for (const n of list) parts.push(u16b(n.length), n);
  }
  return { entry: visualEntry('hvc1', st.width, st.height, mkbox('hvcC', ...parts)), codec, state: st };
}

// ---- NAL header validation ----

// Returns { type, ref, tid } or null if the header bytes cannot start a NAL of a normal stream.
export function nalHeader(codec, h0, h1) {
  if (h0 & 0x80) return null;
  if (codec === 'avc') {
    const type = h0 & 31, ref = (h0 >> 5) & 3;
    switch (type) {
      case 1: return { type, ref };
      case 5: case 7: case 8: return ref ? { type, ref } : null;
      case 6: case 9: case 10: case 11: case 12: return ref ? null : { type, ref };
      default: return null;
    }
  }
  const type = (h0 >> 1) & 63;
  if ((h0 & 1) || (h1 >> 3)) return null; // nuh_layer_id must be 0
  const tid = (h1 & 7) - 1;
  if (tid < 0) return null;
  if (type <= 9 || (type >= 32 && type <= 40)) return { type, tid };
  if (type >= 16 && type <= 21) return tid === 0 ? { type, tid } : null;
  return null;
}

export const isVcl = (codec, t) => (codec === 'avc' ? t === 1 || t === 5 : t <= 21 && (t <= 9 || t >= 16));
export const isKey = (codec, t) => (codec === 'avc' ? t === 5 : t >= 16 && t <= 21);
// NAL types that may precede the first slice of an access unit.
export const isPrefix = (codec, t) => (codec === 'avc' ? t === 6 || t === 7 || t === 8 || t === 9 : (t >= 32 && t <= 35) || t === 39);
// Non-VCL NAL types that may follow the slices inside the same access unit.
export const isSuffix = (codec, t) => (codec === 'avc' ? t === 10 || t === 11 || t === 12 : t >= 36 && t <= 38 || t === 40);

// Parse the start of a first slice (rbsp = unescaped bytes after the NAL header).
// Returns null if the header is inconsistent with the known parameter sets.
export function parseSlice(st, hdr, rbsp) {
  try {
    const r = new Bits(rbsp);
    if (st.codec === 'avc') {
      if (r.ue() !== 0) return null;
      const sliceType = r.ue();
      if (sliceType > 9) return null;
      const pps = st.pps.get(r.ue());
      if (!pps) return null;
      const sps = st.sps.get(pps.spsId);
      if (sps.sep) r.u(2);
      const frameNum = r.u(sps.log2MaxFrameNum);
      const idr = hdr.type === 5;
      if (idr && (frameNum !== 0 || (sliceType % 5 !== 2 && sliceType % 5 !== 4))) return null;
      if (!sps.frameMbsOnly && r.u(1)) r.u(1);
      if (idr) r.ue();
      const lsb = sps.pocType === 0 ? r.u(sps.log2MaxPocLsb) : 0;
      return { ppsId: pps.id, sps, frameNum, lsb, idr, ref: hdr.ref !== 0, type: hdr.type };
    }
    if (!r.u(1)) return null;
    if (hdr.type >= 16 && hdr.type <= 23) r.u(1);
    const pps = st.pps.get(r.ue());
    if (!pps) return null;
    const sps = st.sps.get(pps.spsId);
    r.skip(pps.extraBits);
    const sliceType = r.ue();
    if (sliceType > 2) return null;
    if (hdr.type >= 16 && hdr.type <= 21 && sliceType !== 2) return null;
    if (pps.outputFlag) r.u(1);
    if (sps.sep) r.u(2);
    const idr = hdr.type === 19 || hdr.type === 20;
    const lsb = idr ? 0 : r.u(sps.log2MaxPocLsb);
    return { ppsId: pps.id, sps, lsb, idr, type: hdr.type, tid: hdr.tid };
  } catch {
    return null;
  }
}

// Pull the ppsId out of a non-first slice (to check it belongs to the same picture).
export function slicePpsId(st, hdr, rbsp) {
  try {
    const r = new Bits(rbsp);
    if (st.codec === 'avc') { r.ue(); if (r.ue() > 9) return -1; return r.ue(); }
    r.u(1);
    if (hdr.type >= 16 && hdr.type <= 23) r.u(1);
    return r.ue();
  } catch {
    return -1;
  }
}
