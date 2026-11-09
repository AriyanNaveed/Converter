# Converter

Browser-based recovery tool for JPG photos and MP4/MOV videos encrypted by the `.[ID][email].voxvb` ransomware.

This ransomware only encrypts the first and last 0.5% of each file and leaves the middle untouched. Everything runs locally in the browser, and files are never uploaded.

## Usage

```bash
npm install
npm run dev      # local dev server
npm run build    # static build in dist/
```

Drop one or more `.voxvb` files on the page and download the recovered files. The file type is taken from the original name (`photo.jpg.[ID][email].voxvb`, `clip.mp4.[ID][email].voxvb`, …).

### Photos (JPG)

The JPEG's quantization and Huffman tables and nearly all image data survive in the middle, so the tool rebuilds a valid JPEG around them. The few rows that were in the encrypted tail come out grey, and by default they are trimmed off.

### Videos (MP4 / MOV / M4V / 3GP)

The frames survive, but the index that tells a player where they are (`moov`) usually sits in the encrypted start or end of the file.

1. **Index repair:** if enough of the original `moov` is still readable, it is repaired. Encrypted frames are removed, and audio is kept when its table survived.
2. **Index rebuild:** otherwise the media data is scanned frame by frame (H.264 and HEVC) and a new index is written. Interleaved audio is skipped, and frame order, B-frames and keyframes are restored from the bitstream. The codec settings come from, in order:
   - the surviving part of the original index
   - a copy of the settings found elsewhere in the file
   - a **reference video**, meaning any healthy clip recorded on the same phone/camera with the same resolution, frame rate and codec
   - parameter sets inside the stream (common for action cams and dashcams)

## Limitations

- Videos rebuilt by scanning have no audio.
- Playback starts at the first keyframe after the encrypted start. Frames before it, and the last few frames, are lost.
- Only H.264 and HEVC video can be rebuilt by scanning. Fragmented MP4 is not supported.
- Files smaller than ~9 KB are fully encrypted and cannot be recovered.
- The encrypted bytes themselves cannot be decrypted without the attacker's key.
