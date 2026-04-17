// electron/archive.js — tar.gz extraction helper.
//
// Ports the Rust `extract_tar_gz_native` in src-tauri/src/setup.rs. The Python
// standalone archive we download from python-build-standalone is a .tar.gz
// containing a single top-level directory with symlinks inside (python3 →
// python3.11, etc.), so we need a real tar implementation — not a hand-rolled
// 512-byte-header reader — to preserve symlinks and permissions across
// Linux / macOS / Windows.
//
// Uses the `tar` npm package (pure JS, no native addons, mainstream and
// battle-tested). Streams from a Buffer through zlib → tar.Parse to keep
// peak memory reasonable on lower-RAM laptops — the install_only archive
// is ~50 MB compressed, ~180 MB extracted.
//
// Zip + tar.zst extraction (used by Rust for other platforms) are not needed
// here: python-build-standalone's `install_only` archives are tar.gz on every
// platform we target, including Windows.

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tar = require('tar');

/// Extract a .tar.gz Buffer to `targetDir`. Creates the target directory
/// (and any missing parents) if needed. Errors bubble up verbatim.
export async function extractTarGz(data, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const source = Readable.from(data);
  await pipeline(
    source,
    createGunzip(),
    // tar.extract with strict: false tolerates extended headers (pax) that
    // python-build-standalone archives include for long paths. preserveOwner:
    // false because the downloaded archive's uid/gid won't match the current
    // user — mirrors what rust `tar` does by default when running non-root.
    tar.extract({ cwd: targetDir, preserveOwner: false, strict: false }),
  );
}
