#!/usr/bin/env node
// Node-side test: pure helpers in electron/*.js don't depend on Electron's
// runtime, so we can import + exercise them directly. Covers the math,
// parsing, and string-munging surfaces that underpin the desktop build
// pipeline.
//
// Run: node tests/test-electron-helpers.js
//
// No network access required. No /proc reads (GPU detection is excluded —
// it probes real system commands and would be flaky on CI). Paths test uses
// a stubbed HOME and XDG env so it's hermetic.

import {
  redactBearer, percentEncodePath,
} from '../electron/lens-manager.js';
import {
  verifySha256, pythonStandaloneUrl, pythonArchiveFilename,
} from '../electron/setup.js';
import {
  pickEmbeddingModel, MODEL_BGE_M3, MODEL_MINILM,
} from '../electron/gpu.js';

const results = [];
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS: ${name}`); }
  else { failed++; results.push(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== electron/ pure-helper tests ===\n');

// ── redactBearer ────────────────────────────────────────────────
assert('redact: plain bearer',
  redactBearer('foo Bearer abc123 bar') === 'foo Bearer [REDACTED] bar');
assert('redact: json quoted',
  redactBearer('{"h":"Bearer xyz789"}') === '{"h":"Bearer [REDACTED]"}');
assert('redact: no bearer',
  redactBearer('no bearer here') === 'no bearer here');
assert('redact: multiple',
  redactBearer('Bearer a Bearer b') === 'Bearer [REDACTED] Bearer [REDACTED]',
  `got ${JSON.stringify(redactBearer('Bearer a Bearer b'))}`);
assert('redact: empty string',
  redactBearer('') === '');

// ── percentEncodePath ───────────────────────────────────────────
assert('encode: unchanged alnum',
  percentEncodePath('/foo/bar') === '/foo/bar');
assert('encode: space',
  percentEncodePath('/a b') === '/a%20b');
assert('encode: utf-8 multi-byte',
  percentEncodePath('/café') === '/caf%C3%A9',
  `got ${percentEncodePath('/café')}`);
assert('encode: preserves slash',
  percentEncodePath('/a/b/c.md') === '/a/b/c.md');
assert('encode: reserved chars',
  percentEncodePath('/a?b#c+d') === '/a%3Fb%23c%2Bd');
assert('encode: unreserved pchar',
  percentEncodePath('a-b.c_d~e') === 'a-b.c_d~e');

// ── verifySha256 ────────────────────────────────────────────────
// sha256("hello\n") = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
const helloHash = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
let sha256Ok = false;
try { verifySha256(Buffer.from('hello\n'), helloHash); sha256Ok = true; } catch {}
assert('sha256: exact match', sha256Ok);

let sha256CaseOk = false;
try { verifySha256(Buffer.from('hello\n'), helloHash.toUpperCase()); sha256CaseOk = true; } catch {}
assert('sha256: case-insensitive match', sha256CaseOk);

let sha256MismatchCaught = false;
try { verifySha256(Buffer.from('hello\n'), '0'.repeat(64)); }
catch { sha256MismatchCaught = true; }
assert('sha256: mismatch throws', sha256MismatchCaught);

// ── pythonStandaloneUrl / filename ──────────────────────────────
const url = pythonStandaloneUrl();
assert('python url: github releases host',
  url.startsWith('https://github.com/astral-sh/python-build-standalone/releases/download/'),
  url);
assert('python url: cpython archive',
  url.includes('cpython-3.11.15'), url);
assert('python url: install_only tarball',
  url.endsWith('-install_only.tar.gz'), url);

const filename = pythonArchiveFilename();
assert('python filename: current-platform triple resolves', typeof filename === 'string' && filename.length > 0);

// ── pickEmbeddingModel tiers ────────────────────────────────────
const GB = 1024 * 1024 * 1024;
function mkGpu(provider, vramMb, unified = false, runtime = true) {
  return {
    vendor: 'test', name: 'test', driver_version: null, vram_mb: vramMb,
    architecture: null, recommended_provider: provider,
    runtime_installed: runtime, vram_is_unified: unified, summary: '',
  };
}
assert('pick: cuda 8GB VRAM → BGE-M3',
  pickEmbeddingModel(mkGpu('cuda', 8 * 1024), 16 * GB) === MODEL_BGE_M3);
assert('pick: cuda 4GB VRAM → MiniLM (under 6GB floor)',
  pickEmbeddingModel(mkGpu('cuda', 4 * 1024), 16 * GB) === MODEL_MINILM);
assert('pick: directml 12GB → BGE-M3',
  pickEmbeddingModel(mkGpu('directml', 12 * 1024), 16 * GB) === MODEL_BGE_M3);
assert('pick: rocm excluded even with big VRAM',
  pickEmbeddingModel(mkGpu('rocm', 16 * 1024), 16 * GB) === MODEL_MINILM);
assert('pick: apple unified 16GB → BGE-M3',
  pickEmbeddingModel(mkGpu('coreml', 16 * 1024, true), 0) === MODEL_BGE_M3);
assert('pick: apple unified 8GB → MiniLM',
  pickEmbeddingModel(mkGpu('coreml', 8 * 1024, true), 0) === MODEL_MINILM);
assert('pick: CPU-only 24GB RAM → BGE-M3',
  pickEmbeddingModel({}, 24 * GB) === MODEL_BGE_M3);
assert('pick: CPU-only 16GB RAM → MiniLM',
  pickEmbeddingModel({}, 16 * GB) === MODEL_MINILM);
assert('pick: runtime not installed → MiniLM',
  pickEmbeddingModel(mkGpu('cuda', 8 * 1024, false, false), 16 * GB) === MODEL_MINILM);
assert('pick: vram_mb missing → MiniLM (don\'t gamble)',
  pickEmbeddingModel(mkGpu('cuda', null), 16 * GB) === MODEL_MINILM);

// ── Done ────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\nTotal: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
