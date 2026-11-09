import { useCallback, useEffect, useRef, useState } from 'react';
import { recoverJpeg, originalName, isVideoName } from './recover.js';
import { recoverVideo, readReference } from './mp4/recoverVideo.js';
import './App.css';

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

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

async function processImage(file, autoCrop) {
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
    kind: 'image',
    name: originalName(file.name),
    url: URL.createObjectURL(final),
    rawUrl: URL.createObjectURL(raw),
    outSize: final.size,
    size,
    removed,
    encryptedBytes: r.encryptedBytes,
    origSize: r.origSize,
    thumbs: r.thumbnails.map((t) => ({
      url: URL.createObjectURL(new Blob([t.bytes], { type: 'image/jpeg' })),
      size: t.size,
    })),
  };
}

async function processVideo(file, opts) {
  const r = await recoverVideo(file, opts);
  return {
    kind: 'video',
    name: originalName(file.name),
    url: URL.createObjectURL(r.blob),
    rawUrl: null,
    thumbs: [],
    outSize: r.blob.size,
    size: r.size,
    duration: r.duration,
    frames: r.frames,
    hasAudio: r.hasAudio,
    method: r.method,
    notes: r.notes,
  };
}

function revoke(result) {
  if (!result) return;
  URL.revokeObjectURL(result.url);
  if (result.rawUrl) URL.revokeObjectURL(result.rawUrl);
  result.thumbs.forEach((t) => URL.revokeObjectURL(t.url));
}

let nextId = 1;

export default function App() {
  const [items, setItems] = useState([]);
  const [autoCrop, setAutoCrop] = useState(true);
  const [fps, setFps] = useState(30);
  const [reference, setReference] = useState(null); // { name, cfg } | { name, error }
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const refInputRef = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => itemsRef.current.forEach((it) => revoke(it.result)), []);

  const update = (id, patch) => setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const run = useCallback(
    (it) => {
      const video = isVideoName(it.file.name);
      const job = video
        ? processVideo(it.file, {
          reference: reference?.cfg ?? null,
          fps: Number(fps) > 0 ? Number(fps) : 30,
          onProgress: (f, label) => update(it.id, { progress: f, label }),
        })
        : processImage(it.file, autoCrop);
      job
        .then((result) => update(it.id, { status: 'done', result }))
        .catch((err) => update(it.id, { status: 'error', error: err.message, needsReference: !!err.needsReference }));
    },
    [autoCrop, fps, reference],
  );

  const addFiles = useCallback(
    (fileList) => {
      const fresh = Array.from(fileList).map((f) => ({ id: nextId++, file: f, status: 'working' }));
      setItems((prev) => [...fresh, ...prev]);
      fresh.forEach(run);
    },
    [run],
  );

  const retry = (it) => {
    update(it.id, { status: 'working', error: null, progress: 0, label: null });
    run(it);
  };

  const onReference = async (file) => {
    try {
      const cfg = await readReference(file);
      setReference({ name: file.name, cfg });
    } catch (e) {
      setReference({ name: file.name, error: e.message });
    }
  };

  // When a reference video is added, retry the videos that were waiting for one.
  useEffect(() => {
    if (!reference?.cfg) return;
    for (const it of itemsRef.current) if (it.status === 'error' && it.needsReference) retry(it);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  return (
    <div className="page">
      <header>
        <h1>voxvb Recovery</h1>
        <p className="lead">
          Restore JPG photos and MP4/MOV videos encrypted by the <code>.[ID][email].voxvb</code> ransomware. Everything
          runs in your browser — files are never uploaded anywhere.
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
        <span>JPG and MP4 / MOV — or click to choose, multiple files allowed</span>
      </div>

      <div className="options">
        <label className="option">
          <input type="checkbox" checked={autoCrop} onChange={(e) => setAutoCrop(e.target.checked)} />
          Photos: trim the grey strip at the bottom (the few rows that were encrypted)
        </label>

        <div className="ref-box">
          <div className="ref-text">
            <strong>Videos: reference clip</strong> <span className="muted">(optional)</span>
            <p>
              If a video's settings were encrypted too, add any healthy video recorded on the <em>same phone/camera
              with the same settings</em> (resolution, frame rate, H.264/HEVC). A few seconds is enough.
            </p>
            {reference?.cfg && (
              <p className="ok">
                ✓ {reference.name} — {reference.cfg.codec === 'avc' ? 'H.264' : 'HEVC'} {reference.cfg.state.width}×
                {reference.cfg.state.height}
              </p>
            )}
            {reference?.error && <p className="err">{reference.name}: {reference.error}</p>}
          </div>
          <div className="ref-actions">
            <input
              ref={refInputRef}
              type="file"
              accept="video/*,.mp4,.mov,.m4v,.3gp"
              hidden
              onChange={(e) => { if (e.target.files[0]) onReference(e.target.files[0]); e.target.value = ''; }}
            />
            <button type="button" className="btn" onClick={() => refInputRef.current?.click()}>
              {reference ? 'Change reference' : 'Choose reference video'}
            </button>
            {reference && (
              <button type="button" className="btn" onClick={() => setReference(null)}>Remove</button>
            )}
            <label className="fps">
              Fallback fps
              <input type="number" min="1" max="240" step="any" value={fps} onChange={(e) => setFps(e.target.value)} />
            </label>
          </div>
        </div>
      </div>

      <ul className="list">
        {items.map((it) => (
          <li key={it.id} className={`card ${it.status}`}>
            <div className="card-head">
              <span className="fname" title={it.file.name}>{it.file.name}</span>
              <span className={`badge ${it.status}`}>
                {it.status === 'working'
                  ? it.label ? `${it.label}${it.progress ? ` ${Math.round(it.progress * 100)}%` : ''}` : 'Recovering…'
                  : it.status === 'done' ? 'Recovered' : 'Failed'}
              </span>
            </div>

            {it.status === 'error' && (
              <div className="err-row">
                <p className="err">{it.error}</p>
                {isVideoName(it.file.name) && (
                  <button type="button" className="btn" onClick={() => retry(it)}>Retry</button>
                )}
              </div>
            )}

            {it.status === 'done' && it.result.kind === 'image' && (
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

            {it.status === 'done' && it.result.kind === 'video' && (
              <div className="result">
                <video className="preview-video" src={it.result.url} controls preload="metadata" />
                <div className="meta">
                  <div className="out-name">{it.result.name}</div>
                  <dl>
                    <dt>Method</dt>
                    <dd>{it.result.method}</dd>
                    <dt>Dimensions</dt>
                    <dd>{it.result.size ? `${it.result.size.width} × ${it.result.size.height}` : '—'}</dd>
                    <dt>Duration</dt>
                    <dd>{fmtTime(it.result.duration)} ({it.result.frames} frames)</dd>
                    <dt>Audio</dt>
                    <dd>{it.result.hasAudio ? 'Yes' : 'No'}</dd>
                    <dt>Output size</dt>
                    <dd>{fmtBytes(it.result.outSize)}</dd>
                  </dl>
                  {it.result.notes.length > 0 && (
                    <ul className="notes">{it.result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                  )}
                  <div className="actions">
                    <a className="btn primary" href={it.result.url} download={it.result.name}>Download video</a>
                  </div>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <footer>
        <p>
          How it works: this ransomware only encrypts the first and last 0.5% of each file. For photos the JPEG tables and
          nearly all image data survive in the middle, so the tool rebuilds a valid JPEG around them. For videos the
          frames survive but the index that tells a player where they are (<code>moov</code>) is usually destroyed; the
          tool repairs it if enough is left, or rebuilds it by scanning every H.264/HEVC frame. The encrypted bytes
          themselves cannot be decrypted without the attacker's key.
        </p>
      </footer>
    </div>
  );
}
