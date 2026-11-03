// Recovery for files hit by the ".[ID][email].voxvb" ransomware.
//
// File layout written by the ransomware:
//   [ original file bytes, with the first and last `chunk` bytes encrypted ]
//   [ trailer: u64 len | key blob | u64 len | hash | u64 nonce | u64 origSize | u64 chunk | u64 marker | u64 trailerLen ]
// Only the head and tail are encrypted, so the JPEG's main image header and
// scan data in the middle are still plaintext and can be stitched back together.

const MAGIC = [0xab, 0xbc, 0xcd, 0xde, 0xef, 0xf0, 0x00, 0x42];

const u64 = (b, p) => {
  const v = new DataView(b.buffer, b.byteOffset + p, 8).getBigUint64(0, true);
  return Number(v);
};

export function parseTrailer(bytes) {
  const n = bytes.length;
  if (n < 64) throw new Error('File is too small to be a voxvb-encrypted file.');
  const tl = u64(bytes, n - 8);
  if (tl < 48 || tl > 4096 || tl > n) throw new Error('No voxvb trailer found at the end of this file.');
  const tr = bytes.subarray(n - tl);
  let p = 0;
  const l1 = u64(tr, p); p += 8 + l1;
  const l2 = u64(tr, p); p += 8 + l2;
  if (p + 40 !== tl) throw new Error('Trailer layout not recognized.');
  const origSize = u64(tr, p + 8);
  const chunk = u64(tr, p + 16);
  if (origSize !== n - tl) throw new Error('Trailer size field does not match the file.');
  const hasMagic = MAGIC.every((v, i) => bytes[i] === v);
  return { origSize, chunk, trailerLen: tl, hasMagic };
}

// Markers that may appear in a JPEG header chain before SOS.
const isHeaderMarker = (m) =>
  (m >= 0xc0 && m <= 0xcf && m !== 0xc8) || m === 0xdb || m === 0xdd || (m >= 0xe0 && m <= 0xef) || m === 0xfe;

// Walk segments from `p`; return { sos, hasSOF, hasDQT } if the chain reaches an SOS cleanly.
function walkChain(b, p, limit) {
  let hasSOF = false, hasDQT = false;
  while (p + 4 <= limit) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xda) return { sos: p, hasSOF, hasDQT };
    if (!isHeaderMarker(m)) return null;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return null;
    if (m === 0xdb) hasDQT = true;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xcc) hasSOF = true;
    p += 2 + len;
  }
  return null;
}

function frameSize(b, start, sos) {
  let p = start;
  while (p < sos) {
    const m = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xcc) {
      return { height: (b[p + 5] << 8) | b[p + 6], width: (b[p + 7] << 8) | b[p + 8] };
    }
    p += 2 + len;
  }
  return null;
}

// Find every complete header chain (DQT + SOF ... SOS) inside the plaintext region.
function findImages(b, lo, hi) {
  const bySos = new Map();
  for (let p = lo; p < hi - 4; p++) {
    if (b[p] !== 0xff || !isHeaderMarker(b[p + 1])) continue;
    const r = walkChain(b, p, hi);
    if (!r || !r.hasSOF || !r.hasDQT) continue;
    // keep the earliest start for each SOS (includes the most metadata)
    if (!bySos.has(r.sos)) bySos.set(r.sos, p);
  }
  const images = [];
  for (const [sos, start] of bySos) {
    const sosLen = (b[sos + 2] << 8) | b[sos + 3];
    const dataStart = sos + 2 + sosLen;
    // entropy data ends at the first EOI, or runs into the encrypted tail
    let end = -1;
    for (let i = dataStart; i < hi - 1; i++) {
      if (b[i] === 0xff && b[i + 1] === 0xd9) { end = i; break; }
    }
    images.push({ start, sos, dataStart, eoi: end, size: frameSize(b, start, sos) });
  }
  return images;
}

export function recoverJpeg(bytes) {
  const info = parseTrailer(bytes);
  const { origSize, chunk } = info;
  if (origSize <= chunk * 2) {
    throw new Error('This file is small enough that it was fully encrypted; it cannot be recovered without the key.');
  }
  const lo = chunk, hi = origSize - chunk;
  const body = bytes.subarray(0, origSize);
  const images = findImages(body, lo, hi);
  if (!images.length) throw new Error('No intact JPEG image header found in the unencrypted part of this file.');

  const area = (im) => (im.size ? im.size.width * im.size.height : 0);
  // The main image is the largest one; it normally runs into the encrypted tail.
  const main = images.reduce((a, c) => (area(c) > area(a) ? c : a));
  const thumbs = images.filter((im) => im !== main && im.eoi > 0);

  let cut, truncated;
  if (main.eoi > 0) {
    cut = main.eoi; truncated = false;
  } else {
    // Cut at the last restart marker so the decoder resyncs cleanly; otherwise at the tail boundary.
    cut = hi; truncated = true;
    for (let i = hi - 2; i >= main.dataStart; i--) {
      if (body[i] === 0xff && body[i + 1] >= 0xd0 && body[i + 1] <= 0xd7) { cut = i; break; }
    }
  }

  const out = new Uint8Array(2 + (cut - main.start) + 2);
  out.set([0xff, 0xd8], 0);
  out.set(body.subarray(main.start, cut), 2);
  out.set([0xff, 0xd9], out.length - 2);

  const thumbnails = thumbs.map((t) => {
    const t2 = new Uint8Array(2 + (t.eoi + 2 - t.start));
    t2.set([0xff, 0xd8], 0);
    t2.set(body.subarray(t.start, t.eoi + 2), 2);
    return { bytes: t2, size: t.size };
  });

  return {
    jpeg: out,
    size: main.size,
    truncated,
    encryptedBytes: chunk * 2,
    origSize,
    thumbnails,
    trailer: info,
  };
}

// "Mockup.jpg.[6ABE22B2][opnrdp@gmail.com].voxvb" -> "Mockup.jpg"
export function originalName(name) {
  const m = name.match(/^(.*?)\.\[[0-9A-Fa-f]+\](?:\.)?\[[^\]]*\]\.[A-Za-z0-9]+$/);
  let base = m ? m[1] : name.replace(/\.voxvb$/i, '');
  if (!/\.(jpe?g)$/i.test(base)) base += '.jpg';
  return base;
}
