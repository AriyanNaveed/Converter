import { useCallback, useEffect, useRef, useState } from 'react';
import { recoverJpeg, originalName } from './recover.js';
import './App.css';

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Browser could not decode the rebuilt image.'));
    img.src = url;
  });

// Decoders fill the missing (encrypted) tail with flat grey or leave it transparent.
// Find the last row that still has real picture data.
function lastGoodRow(ctx, w, h) {
  const step = Math.max(1, Math.floor(w / 400));
  for (let y = h - 1; y >= 0; y--) {
    const row = ctx.getImageData(0, y, w, 1).data;
    let real = 0;
    for (let x = 0; x < w; x += step) {
      const i = x * 4;
      const a = row[i + 3], r = row[i], g = row[i + 1], b = row[i + 2];
      if (a > 0 && (Math.abs(r - 128) > 6 || Math.abs(g - 128) > 6 || Math.abs(b - 128) > 6)) real++;
    }
    if (real > (w / step) * 0.05) return y;
  }
  return h - 1;
}

async function cropMissing(blob, quality) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const keep = lastGoodRow(ctx, w, h) + 1;
    const out = document.createElement('canvas');
    out.width = w; out.height = keep;
    out.getContext('2d').drawImage(canvas, 0, 0);
    const cropped = await new Promise((res) => out.toBlob(res, 'image/jpeg', quality));
    return { blob: cropped, removed: h - keep, width: w, height: keep };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function processFile(file, autoCrop) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = recoverJpeg(bytes);
  const raw = new Blob([r.jpeg], { type: 'image/jpeg' });
  let final = raw, removed = 0, size = r.size;
  if (autoCrop && r.truncated) {
    const c = await cropMissing(raw, 0.95);
    if (c.removed > 0) {
      final = c.blob; removed = c.removed;
      size = { width: c.width, height: c.height };
    }
  }
  return {
    name: originalName(file.name),
    url: URL.createObjectURL(final),
    rawUrl: URL.createObjectURL(raw),
    outSize: final.size,
    size,
    origDims: r.size,
    removed,
    encryptedBytes: r.encryptedBytes,
    origSize: r.origSize,
    thumbs: r.thumbnails.map((t) => ({
      url: URL.createObjectURL(new Blob([t.bytes], { type: 'image/jpeg' })),
      size: t.size,
    })),
  };
}

let nextId = 1;

export default function App() {
  const [items, setItems] = useState([]);
  const [autoCrop, setAutoCrop] = useState(true);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => {
    for (const it of itemsRef.current) {
      if (!it.result) continue;
      URL.revokeObjectURL(it.result.url);
      URL.revokeObjectURL(it.result.rawUrl);
      it.result.thumbs.forEach((t) => URL.revokeObjectURL(t.url));
    }
  }, []);

  const addFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList);
      const fresh = files.map((f) => ({ id: nextId++, file: f, status: 'working' }));
      setItems((prev) => [...fresh, ...prev]);
      for (const it of fresh) {
        processFile(it.file, autoCrop)
          .then((result) => setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, status: 'done', result } : p))))
          .catch((err) => setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, status: 'error', error: err.message } : p))));
      }
    },
    [autoCrop],
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  return (
    <div className="page">
      <header>
        <h1>voxvb JPEG Recovery</h1>
        <p className="lead">
          Restore JPG images encrypted by the <code>.[ID][email].voxvb</code> ransomware. Everything runs in your
          browser — files are never uploaded anywhere.
        </p>
      </header>

      <div
        className={`drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; }}
        />
        <div className="drop-icon">⬆</div>
        <strong>Drop encrypted .voxvb files here</strong>
        <span>or click to choose — multiple files allowed</span>
      </div>

      <label className="option">
        <input type="checkbox" checked={autoCrop} onChange={(e) => setAutoCrop(e.target.checked)} />
        Trim the grey strip at the bottom (the few rows that were encrypted)
      </label>

      <ul className="list">
        {items.map((it) => (
          <li key={it.id} className={`card ${it.status}`}>
            <div className="card-head">
              <span className="fname" title={it.file.name}>{it.file.name}</span>
              <span className={`badge ${it.status}`}>
                {it.status === 'working' ? 'Recovering…' : it.status === 'done' ? 'Recovered' : 'Failed'}
              </span>
            </div>

            {it.status === 'error' && <p className="err">{it.error}</p>}

            {it.status === 'done' && (
              <div className="result">
                <a href={it.result.url} target="_blank" rel="noreferrer" className="preview">
                  <img src={it.result.url} alt={it.result.name} />
                </a>
                <div className="meta">
                  <div className="out-name">{it.result.name}</div>
                  <dl>
                    <dt>Dimensions</dt>
                    <dd>{it.result.size ? `${it.result.size.width} × ${it.result.size.height}` : '—'}</dd>
                    <dt>Output size</dt>
                    <dd>{fmtBytes(it.result.outSize)}</dd>
                    <dt>Recovered</dt>
                    <dd>
                      {(100 - (it.result.encryptedBytes / it.result.origSize) * 100).toFixed(1)}% of the file was intact
                    </dd>
                    {it.result.removed > 0 && (
                      <>
                        <dt>Trimmed</dt>
                        <dd>{it.result.removed} px unrecoverable rows at the bottom</dd>
                      </>
                    )}
                  </dl>
                  <div className="actions">
                    <a className="btn primary" href={it.result.url} download={it.result.name}>Download JPG</a>
                    {it.result.removed > 0 && (
                      <a className="btn" href={it.result.rawUrl} download={it.result.name.replace(/(\.[^.]+)$/, '_full$1')}>
                        Untrimmed original
                      </a>
                    )}
                    {it.result.thumbs.map((t, i) => (
                      <a key={i} className="btn" href={t.url} download={it.result.name.replace(/(\.[^.]+)$/, `_thumb${i + 1}$1`)}>
                        Thumbnail {t.size ? `${t.size.width}×${t.size.height}` : ''}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <footer>
        <p>
          How it works: this ransomware only encrypts the first and last few KB of each file. The JPEG's quantization and
          Huffman tables and nearly all image data survive in the middle, so the tool rebuilds a valid JPEG around them.
          The encrypted bytes themselves cannot be decrypted without the attacker's key.
        </p>
      </footer>
    </div>
  );
}
