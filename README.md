# Converter

Browser-based recovery tool for JPG images encrypted by the `.[ID][email].voxvb` ransomware.

This ransomware only encrypts the first and last few KB of each file. The JPEG's quantization/Huffman tables and nearly all image data survive in the middle, so the tool rebuilds a valid JPEG around them. Everything runs locally in the browser — files are never uploaded.

## Usage

```bash
npm install
npm run dev      # local dev server
npm run build    # static build in dist/
```

Drop one or more `.voxvb` files on the page and download the recovered JPGs. The few rows that were in the encrypted tail come out grey; by default they are trimmed off.

## Limitations

- JPG/JPEG only.
- Files smaller than ~9 KB are fully encrypted and cannot be recovered.
- The encrypted bytes themselves cannot be decrypted without the attacker's key.
