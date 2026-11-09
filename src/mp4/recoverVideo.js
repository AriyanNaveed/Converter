// Recovery of MP4 / MOV videos hit by the ".[ID][email].voxvb" ransomware.
//
// The ransomware encrypts the first and last 0.5% of the file. For a video that usually destroys
// the small boxes at the start (ftyp, and moov for "fast-start" files) and the end of the file
// (moov for camera/phone recordings), while the media data in between survives. We either
//   A) repair the original index (moov) when enough of it is still in plaintext, or
//   B) rebuild a new index by walking the H.264/HEVC frames in the surviving media data.
// Works on a Blob/File so multi-GB videos are never fully loaded into memory.

import { parseTrailer } from '../recover.js';
import { parseBoxes, readTrack, buildMovie, fourcc, be32, be64 } from './boxes.js';
import { codecFromEntry, buildEntry, nalHeader, AVC_ENTRIES, HEVC_ENTRIES } from './codec.js';
import { scanFrames, buildTimeline } from './scan.js';

const SEARCH_WINDOW = 32 << 20;

const readAt = async (blob, start, end) => ({ start, b: new Uint8Array(await blob.slice(start, end).arrayBuffer()) });

// ---------- locating structures in the plaintext part ----------

function findMoovIn(win, origSize) {
  const { b, start } = win;
  const out = [];
  for (let i = 0; i + 16 <= b.length; i++) {
    if (b[i + 4] !== 0x6d || b[i + 5] !== 0x6f || b[i + 6] !== 0x6f || b[i + 7] !== 0x76) continue; // 'moov'
    if (fourcc(b, i + 12) !== 'mvhd') continue;
    const size = be32(b, i);
    if (size < 116 || start + i + size > origSize) continue;
    out.push({ pos: start + i, size });
  }
  return out;
}

function findMdatIn(win, lo) {
  const { b, start } = win;
  for (let i = 0; i + 16 <= b.length; i++) {
    if (b[i + 4] !== 0x6d || b[i + 5] !== 0x64 || b[i + 6] !== 0x61 || b[i + 7] !== 0x74) continue; // 'mdat'
    if (start + i < lo) continue;
    let size = be32(b, i), hdr = 8;
    if (size === 1) { size = be64(b, i + 8); hdr = 16; }
    if (size !== 0 && size < hdr) continue;
    return { pos: start + i, payload: start + i + hdr, end: size ? start + i + size : Infinity };
  }
  return null;
}

// A visual sample entry (avc1/hvc1 …) whose avcC/hvcC survived somewhere in plaintext.
function findOrphanEntry(win) {
  const { b } = win;
  for (let i = 90; i + 8 <= b.length; i++) {
    if (b[i] !== 0x61 && b[i] !== 0x68) continue;
    const t = fourcc(b, i);
    if (t !== 'avcC' && t !== 'hvcC') continue;
    const e = i - 4 - 86;
    const et = fourcc(b, e + 4);
    if (!(t === 'avcC' ? AVC_ENTRIES : HEVC_ENTRIES).has(et)) continue;
    const size = be32(b, e);
    if (size < 100 || size > 65536 || e + size > b.length) continue;
    try { return codecFromEntry(b.slice(e, e + size)); } catch { /* keep looking */ }
  }
  return null;
}

// In-band parameter sets (common for action cams / dashcams): SPS+PPS (H.264) or VPS+SPS+PPS (HEVC).
function findInbandConfig(win, from) {
  const { b, start } = win;
  const nalAt = (i) => {
    if (i + 6 > b.length) return null;
    const L = be32(b, i);
    if (L < 4 || L > 1024 || i + 4 + L > b.length) return null;
    return { L, h0: b[i + 4], h1: b[i + 5], nal: b.subarray(i + 4, i + 4 + L) };
  };
  for (let i = Math.max(0, from - start); i + 8 < b.length; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0) continue;
    const n = nalAt(i);
    if (!n) continue;
    for (const codec of ['avc', 'hevc']) {
      const h = nalHeader(codec, n.h0, n.h1);
      if (!h || h.type !== (codec === 'avc' ? 7 : 32)) continue;
      const sets = { vps: [], sps: [], pps: [] };
      let p = i;
      for (let k = 0; k < 16; k++) {
        const m = nalAt(p);
        const mh = m && nalHeader(codec, m.h0, m.h1);
        if (!mh) break;
        const kind = codec === 'avc' ? { 7: 'sps', 8: 'pps' }[mh.type] : { 32: 'vps', 33: 'sps', 34: 'pps' }[mh.type];
        if (!kind) break;
        sets[kind].push(m.nal.slice());
        p += 4 + m.L;
      }
      if (!sets.sps.length || !sets.pps.length || (codec === 'hevc' && !sets.vps.length)) continue;
      try { return buildEntry(codec, sets); } catch { /* not a real parameter set */ }
    }
  }
  return null;
}

// Pull the video config out of a healthy reference video from the same camera/phone.
export async function readReference(file) {
  let p = 0;
  while (p + 8 <= file.size) {
    const { b } = await readAt(file, p, p + 16);
    let size = be32(b, 0);
    const type = fourcc(b, 4);
    if (size === 1) size = be64(b, 8);
    else if (size === 0) size = file.size - p;
    if (size < 8) break;
    if (type === 'moov') {
      const { b: m } = await readAt(file, p, p + size);
      const [node] = parseBoxes(m, 0, m.length);
      for (const trak of node.children.filter((c) => c.type === 'trak')) {
        const t = readTrack(m, trak);
        if (t.handler !== 'vide' || !t.entry) continue;
        const cfg = codecFromEntry(t.entry);
        return { ...cfg, timescale: t.timescale, delta: t.delta, source: 'reference video' };
      }
      throw new Error('The reference file has no H.264/HEVC video track.');
    }
    p += size;
  }
  throw new Error('The reference file is not a readable MP4/MOV (no moov box found).');
}

// ---------- path A: repair the existing index ----------

function trimTracks(tracks, lo, hi) {
  const inPlain = (s) => s.off >= lo && s.off + s.size <= hi;
  const video = tracks.filter((t) => t.handler === 'vide' && t.samples?.length)
    .sort((a, b) => b.samples.length - a.samples.length)[0];
  if (!video) return null;
  const vs = video.samples;
  const i0 = vs.findIndex((s) => s.key && inPlain(s));
  if (i0 < 0) return null;
  let i1 = i0;
  while (i1 < vs.length && inPlain(vs[i1])) i1++;
  let t = 0;
  const dts = vs.map((s) => { const d = t; t += s.dur; return d; });
  const T0 = dts[i0] / video.timescale;
  const T1 = (i1 < vs.length ? dts[i1] : t) / video.timescale;

  const kept = vs.slice(i0, i1);
  let acc = 0, minPts = Infinity;
  for (const s of kept) { minPts = Math.min(minPts, acc + s.cto); acc += s.dur; }
  let mediaTime = 0;
  if (minPts > 0) mediaTime = minPts;
  else if (minPts < 0) kept.forEach((s) => { s.cto -= minPts; });
  const out = [{ ...video, samples: kept, mediaTime }];

  for (const a of tracks) {
    if (a.handler !== 'soun' || !a.samples?.length) continue;
    let ta = 0;
    const ks = a.samples.filter((s) => {
      const time = ta / a.timescale;
      ta += s.dur;
      return inPlain(s) && time >= T0 && time < T1;
    });
    if (ks.length) out.push({ ...a, samples: ks, mediaTime: 0 });
  }
  return { tracks: out, droppedStart: i0, droppedEnd: vs.length - i1, total: vs.length };
}

// ---------- main entry ----------

export async function recoverVideo(file, { reference = null, fps = 30, onProgress } = {}) {
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 4096)).arrayBuffer());
  const { origSize, chunk } = parseTrailer(tail, file.size);
  if (origSize <= chunk * 2 + 1024) {
    throw new Error('This file is small enough that it was fully encrypted; it cannot be recovered without the key.');
  }
  const lo = chunk, hi = origSize - chunk;
  const src = file.slice(0, origSize);
  const quicktime = /\.mov\b/i.test(file.name);
  const notes = [];
  const progress = (f, label) => onProgress?.(f, label);

  progress(0, 'Looking for the video index…');
  const head = await readAt(src, lo, Math.min(hi, lo + SEARCH_WINDOW));
  const tailWin = hi - SEARCH_WINDOW > head.start + head.b.length ? await readAt(src, hi - SEARCH_WINDOW, hi) : null;
  const wins = tailWin ? [tailWin, head] : [head];

  let S = lo, E = hi;
  const mdat = findMdatIn(head, lo);
  if (mdat) { S = Math.max(S, mdat.payload); E = Math.min(E, mdat.end); }

  // ---- A: original moov still (partly) readable ----
  let partialVideo = null;
  const moovs = wins.flatMap((w) => findMoovIn(w, origSize));
  for (const mv of moovs) {
    const avail = Math.min(mv.pos + mv.size, hi) - mv.pos;
    const { b } = await readAt(src, mv.pos, mv.pos + avail);
    const [node] = parseBoxes(b, 0, b.length);
    if (!node?.children) continue;
    const tracks = node.children.filter((c) => c.type === 'trak').map((t) => readTrack(b, t));
    if (mv.pos > (lo + hi) / 2) E = Math.min(E, mv.pos); else S = Math.max(S, mv.pos + mv.size);

    const usable = tracks.filter((t) => t.samples?.length && t.samples.every((s) => s.off + s.size <= origSize));
    const trimmed = trimTracks(usable, lo, hi);
    if (trimmed) {
      const lostAudio = tracks.some((t) => t.handler === 'soun') && !trimmed.tracks.some((t) => t.handler === 'soun');
      if (trimmed.droppedStart) notes.push(`${trimmed.droppedStart} frame(s) at the start were encrypted and removed.`);
      if (trimmed.droppedEnd) notes.push(`${trimmed.droppedEnd} frame(s) at the end were encrypted and removed.`);
      if (lostAudio) notes.push('The audio track index was destroyed, so the video has no sound.');
      return finish(src, trimmed.tracks, { quicktime, method: 'Original index repaired', notes });
    }
    const v = tracks.find((t) => t.handler === 'vide' && t.entry);
    if (v && !partialVideo) partialVideo = v;
  }

  // ---- B: rebuild the index by scanning frames ----
  const configs = [];
  if (partialVideo) {
    try {
      configs.push({ ...codecFromEntry(partialVideo.entry), timescale: partialVideo.timescale, delta: partialVideo.delta, tkhd: partialVideo.tkhd, source: 'surviving part of the original index' });
    } catch { /* unsupported codec in partial moov */ }
  }
  for (const w of wins) {
    const o = findOrphanEntry(w);
    if (o) { configs.push({ ...o, source: 'codec settings found in the file' }); break; }
  }
  if (reference) configs.push(reference);
  const inband = findInbandConfig(head, S);
  if (inband) configs.push({ ...inband, source: 'parameter sets inside the video stream' });

  if (!configs.length) {
    const err = new Error(
      'The video index and codec settings were both encrypted. Add a reference video (any short clip recorded on the same phone/camera with the same settings) and try again.',
    );
    err.needsReference = true;
    throw err;
  }

  for (const cfg of configs) {
    let timescale = cfg.timescale, delta = cfg.delta, fpsGuessed = false;
    const vui = [...cfg.state.sps.values()][0]?.timing;
    if (!timescale || !delta) {
      if (vui) {
        const k = Math.max(1, Math.ceil(10000 / vui.scale));
        timescale = vui.scale * k; delta = 2 * vui.units * k;
      } else {
        timescale = 90000; delta = Math.max(1, Math.round(90000 / fps)); fpsGuessed = true;
      }
    }
    progress(0, `Scanning frames (${cfg.codec === 'avc' ? 'H.264' : 'HEVC'})…`);
    const frames = await scanFrames(src, cfg.state, S, E, (f) => progress(f, 'Scanning frames…'));
    if (frames.length < 2) continue;
    const { samples, mediaTime } = buildTimeline(cfg.state, frames, delta);
    const width = cfg.state.width || be16(cfg.entry, 32), height = cfg.state.height || be16(cfg.entry, 34);
    const track = { handler: 'vide', timescale, samples, entry: cfg.entry, tkhd: cfg.tkhd ?? null, width, height, mediaTime };
    notes.push(`Video settings taken from the ${cfg.source}.`);
    if (fpsGuessed) notes.push(`Frame rate was unknown and set to ${fps} fps.`);
    notes.push('Audio could not be rebuilt without the original index, so the video has no sound.');
    return finish(src, [track], { quicktime: false, method: 'Index rebuilt from video frames', notes });
  }
  const err = new Error(
    reference
      ? 'No video frames matching the reference video were found. Make sure the reference was recorded on the same device with the same resolution, frame rate and codec (H.264 / HEVC).'
      : 'Could not find video frames with the codec settings found in the file. Try adding a reference video from the same device.',
  );
  err.needsReference = !reference;
  throw err;
}

const be16 = (b, p) => (b[p] << 8) | b[p + 1];

function finish(src, tracks, { quicktime, method, notes }) {
  let A = Infinity, B = 0;
  for (const t of tracks) for (const s of t.samples) { A = Math.min(A, s.off); B = Math.max(B, s.off + s.size); }
  const { head, moov, duration } = buildMovie(tracks, A, B, { quicktime });
  const blob = new Blob([head, src.slice(A, B), moov], { type: quicktime ? 'video/quicktime' : 'video/mp4' });
  const v = tracks.find((t) => t.handler === 'vide');
  const width = v.width || (v.entry ? be16(v.entry, 32) : 0) || (v.stsd ? be16(v.stsd, 16 + 32) : 0);
  const height = v.height || (v.entry ? be16(v.entry, 34) : 0) || (v.stsd ? be16(v.stsd, 16 + 34) : 0);
  return {
    blob,
    method,
    notes,
    duration,
    frames: v.samples.length,
    size: width && height ? { width, height } : null,
    hasAudio: tracks.some((t) => t.handler === 'soun'),
  };
}
