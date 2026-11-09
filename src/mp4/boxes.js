// ISO-BMFF (MP4/MOV) box parsing, sample-table decoding and a minimal movie writer.

export const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
export const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
export const be64 = (b, p) => be32(b, p) * 4294967296 + be32(b, p + 4);
const s32 = (b, p) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex']);

// Parse boxes in b[start, end). A box whose declared size runs past `end` is marked incomplete.
export function parseBoxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = be32(b, p), hdr = 8;
    const type = fourcc(b, p + 4);
    if (!/^[\x20-\x7e]{4}$/.test(type) && type !== '\xa9too') break;
    if (size === 1) { if (p + 16 > end) break; size = be64(b, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr) break;
    const node = { type, start: p, size, hdr, complete: p + size <= end };
    if (CONTAINERS.has(type)) node.children = parseBoxes(b, p + hdr, Math.min(p + size, end));
    out.push(node);
    p += size;
  }
  return out;
}

export const child = (node, type) => node?.children?.find((c) => c.type === type) ?? null;
const done = (node) => (node && node.complete ? node : null);
const raw = (b, node) => b.slice(node.start, node.start + node.size);
const body = (node) => node.start + node.hdr;

function readSamples(b, stbl) {
  const stsz = done(child(stbl, 'stsz')), stz2 = done(child(stbl, 'stz2'));
  const stco = done(child(stbl, 'stco')), co64 = done(child(stbl, 'co64'));
  const stsc = done(child(stbl, 'stsc')), stts = done(child(stbl, 'stts'));
  if (!(stsz || stz2) || !(stco || co64) || !stsc || !stts) return null;
  for (const t of ['stss', 'ctts']) { const n = child(stbl, t); if (n && !n.complete) return null; }

  let sizes;
  if (stsz) {
    const p = body(stsz), fixed = be32(b, p + 4), n = be32(b, p + 8);
    sizes = new Array(n);
    for (let i = 0; i < n; i++) sizes[i] = fixed || be32(b, p + 12 + i * 4);
  } else {
    const p = body(stz2), fs = b[p + 7], n = be32(b, p + 8);
    sizes = new Array(n);
    for (let i = 0; i < n; i++) {
      sizes[i] = fs === 16 ? (b[p + 12 + i * 2] << 8) | b[p + 13 + i * 2]
        : fs === 8 ? b[p + 12 + i] : (b[p + 12 + (i >> 1)] >> ((i & 1) ? 0 : 4)) & 15;
    }
  }
  const n = sizes.length;

  const chunks = [];
  if (stco) { const p = body(stco), c = be32(b, p + 4); for (let i = 0; i < c; i++) chunks.push(be32(b, p + 8 + i * 4)); }
  else { const p = body(co64), c = be32(b, p + 4); for (let i = 0; i < c; i++) chunks.push(be64(b, p + 8 + i * 8)); }

  const samples = new Array(n);
  {
    const p = body(stsc), ec = be32(b, p + 4);
    let s = 0;
    for (let e = 0; e < ec && s < n; e++) {
      const first = be32(b, p + 8 + e * 12) - 1, spc = be32(b, p + 12 + e * 12);
      const last = e + 1 < ec ? be32(b, p + 8 + (e + 1) * 12) - 1 : chunks.length;
      for (let c = first; c < last && s < n; c++) {
        let off = chunks[c];
        for (let k = 0; k < spc && s < n; k++, s++) {
          samples[s] = { off, size: sizes[s], dur: 0, cto: 0, key: true };
          off += sizes[s];
        }
      }
    }
    if (s < n) return null;
  }
  {
    const p = body(stts), ec = be32(b, p + 4);
    let s = 0;
    for (let e = 0; e < ec; e++) {
      const c = be32(b, p + 8 + e * 8), d = be32(b, p + 12 + e * 8);
      for (let k = 0; k < c && s < n; k++) samples[s++].dur = d;
    }
    if (s < n) { const d = s ? samples[s - 1].dur : 1; while (s < n) samples[s++].dur = d; }
  }
  const ctts = child(stbl, 'ctts');
  if (ctts) {
    const p = body(ctts), ec = be32(b, p + 4);
    let s = 0;
    for (let e = 0; e < ec; e++) {
      const c = be32(b, p + 8 + e * 8), o = s32(b, p + 12 + e * 8);
      for (let k = 0; k < c && s < n; k++) samples[s++].cto = o;
    }
  }
  const stss = child(stbl, 'stss');
  if (stss) {
    for (const s of samples) s.key = false;
    const p = body(stss), ec = be32(b, p + 4);
    for (let e = 0; e < ec; e++) { const i = be32(b, p + 8 + e * 4) - 1; if (samples[i]) samples[i].key = true; }
  }
  return samples;
}

// Decode one trak. Returns what could be read; `samples` is null when the tables are incomplete.
export function readTrack(b, trak) {
  const mdia = child(trak, 'mdia'), minf = child(mdia, 'minf'), stbl = child(minf, 'stbl');
  const mdhd = done(child(mdia, 'mdhd')), hdlr = done(child(mdia, 'hdlr')), tkhd = done(child(trak, 'tkhd'));
  const stsd = done(child(stbl, 'stsd'));
  const t = {
    handler: hdlr ? fourcc(b, body(hdlr) + 8) : null,
    timescale: mdhd ? be32(b, body(mdhd) + (b[body(mdhd)] === 1 ? 20 : 12)) : 0,
    tkhd: tkhd ? raw(b, tkhd) : null,
    mdhd: mdhd ? raw(b, mdhd) : null,
    hdlr: hdlr ? raw(b, hdlr) : null,
    mhd: ['vmhd', 'smhd', 'nmhd', 'gmhd'].map((x) => done(child(minf, x))).find(Boolean),
    stsd: stsd ? raw(b, stsd) : null,
    entry: null,
    delta: 0,
    samples: null,
  };
  if (t.mhd) t.mhd = raw(b, t.mhd);
  if (stsd && be32(b, body(stsd) + 4) >= 1) {
    const p = body(stsd) + 8, sz = be32(b, p);
    if (p + sz <= stsd.start + stsd.size) t.entry = b.slice(p, p + sz);
  }
  const stts = done(child(stbl, 'stts'));
  if (stts && be32(b, body(stts) + 4) > 0) {
    // most common duration
    let best = 0, bestCount = 0;
    for (let e = 0, ec = be32(b, body(stts) + 4); e < ec; e++) {
      const c = be32(b, body(stts) + 8 + e * 8);
      if (c > bestCount) { bestCount = c; best = be32(b, body(stts) + 12 + e * 8); }
    }
    t.delta = best;
  }
  if (t.stsd && t.timescale && t.handler) t.samples = readSamples(b, stbl);
  return t;
}

// ---------------- writer ----------------

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u8 = (...v) => new Uint8Array(v);
const u16 = (v) => u8((v >> 8) & 255, v & 255);
const u32 = (v) => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const u64 = (v) => concat([u32(Math.floor(v / 4294967296)), u32(v >>> 0)]);
const str = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const box = (type, ...parts) => { const b = concat(parts); return concat([u32(b.length + 8), str(type), b]); };
const full = (type, v, flags, ...parts) => box(type, u8(v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
const MATRIX = concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

function u32Table(values, width = 4) {
  const out = new Uint8Array(values.length * width);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => {
    if (width === 8) { dv.setUint32(i * 8, Math.floor(v / 4294967296)); dv.setUint32(i * 8 + 4, v >>> 0); }
    else dv.setUint32(i * 4, v >>> 0);
  });
  return out;
}

function rle(values) {
  const runs = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++; else runs.push([1, v]);
  }
  return runs;
}

function stbl(track, offsets) {
  const s = track.samples;
  const parts = [];
  const stsd = track.stsd ?? full('stsd', 0, 0, u32(1), track.entry);
  parts.push(stsd);
  const tts = rle(s.map((x) => x.dur));
  parts.push(full('stts', 0, 0, u32(tts.length), u32Table(tts.flat())));
  if (s.some((x) => x.cto !== 0)) {
    const runs = rle(s.map((x) => x.cto));
    const neg = runs.some((r) => r[1] < 0);
    parts.push(full('ctts', neg ? 1 : 0, 0, u32(runs.length), u32Table(runs.flat().map((v) => v >>> 0))));
  }
  if (s.some((x) => !x.key)) {
    const keys = [];
    s.forEach((x, i) => x.key && keys.push(i + 1));
    parts.push(full('stss', 0, 0, u32(keys.length), u32Table(keys)));
  }
  parts.push(full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)));
  parts.push(full('stsz', 0, 0, u32(0), u32(s.length), u32Table(s.map((x) => x.size))));
  const big = offsets.length && offsets[offsets.length - 1] > 0xffffffff;
  parts.push(full(big ? 'co64' : 'stco', 0, 0, u32(offsets.length), u32Table(offsets, big ? 8 : 4)));
  return box('stbl', ...parts);
}

function patchDuration(rawBox, kind, duration, trackId) {
  const b = rawBox.slice();
  const dv = new DataView(b.buffer);
  const v1 = b[8] === 1;
  const put = (pos, val, wide) => {
    if (wide) { dv.setUint32(pos, Math.floor(val / 4294967296)); dv.setUint32(pos + 4, val >>> 0); }
    else dv.setUint32(pos, Math.min(val, 0xffffffff));
  };
  if (kind === 'tkhd') {
    b[11] |= 3; // enabled + in movie
    if (v1) { dv.setUint32(28, trackId); put(36, duration, true); }
    else { dv.setUint32(20, trackId); put(28, duration, false); }
  } else if (kind === 'mdhd') {
    put(v1 ? 32 : 24, duration, v1);
  }
  return b;
}

// tracks: [{ handler, timescale, samples, entry|stsd, tkhd?, mdhd?, hdlr?, mhd?, width, height, mediaTime }]
// Returns { head, moov, offsetBase } — the output file is head + source[A,B) + moov.
export function buildMovie(tracks, A, B, { quicktime = false } = {}) {
  const ftyp = quicktime
    ? box('ftyp', str('qt  '), u32(0x200), str('qt  '))
    : box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const payload = B - A;
  const mdatHdr = payload + 8 > 0xffffffff ? concat([u32(1), str('mdat'), u64(payload + 16)]) : concat([u32(payload + 8), str('mdat')]);
  const base = ftyp.length + mdatHdr.length;
  const MT = 1000;
  let movieDur = 0;

  const traks = tracks.map((t, i) => {
    const id = i + 1;
    const mediaDur = t.samples.reduce((s, x) => s + x.dur, 0);
    const segDur = Math.round((mediaDur / t.timescale) * MT);
    movieDur = Math.max(movieDur, segDur);
    const vide = t.handler === 'vide';
    const tkhd = t.tkhd ? patchDuration(t.tkhd, 'tkhd', segDur, id)
      : full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(segDur), new Uint8Array(8), u16(0), u16(0),
        u16(vide ? 0 : 0x100), u16(0), MATRIX, u32((t.width || 0) * 65536), u32((t.height || 0) * 65536));
    const mdhd = t.mdhd ? patchDuration(t.mdhd, 'mdhd', mediaDur)
      : full('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(mediaDur), u16(0x55c4), u16(0));
    const hdlr = t.hdlr ?? full('hdlr', 0, 0, u32(0), str(t.handler), new Uint8Array(12), str(vide ? 'VideoHandler\0' : 'Handler\0'));
    const mhd = t.mhd ?? (vide ? full('vmhd', 0, 1, new Uint8Array(8)) : t.handler === 'soun' ? full('smhd', 0, 0, u32(0)) : full('nmhd', 0, 0));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const offsets = t.samples.map((x) => x.off - A + base);
    const minf = box('minf', mhd, dinf, stbl(t, offsets));
    const parts = [tkhd];
    if (t.mediaTime > 0) {
      parts.push(box('edts', full('elst', 0, 0, u32(1), u32(segDur), u32(t.mediaTime), u32(0x10000))));
    }
    parts.push(box('mdia', mdhd, hdlr, minf));
    return box('trak', ...parts);
  });

  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(MT), u32(movieDur), u32(0x10000), u16(0x100),
    new Uint8Array(10), MATRIX, new Uint8Array(24), u32(tracks.length + 1));
  return { head: concat([ftyp, mdatHdr]), moov: box('moov', mvhd, ...traks), duration: movieDur / MT };
}
