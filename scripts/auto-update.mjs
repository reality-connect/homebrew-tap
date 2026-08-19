#!/usr/bin/env node
/**
 * auto-update.mjs — the Homebrew tap receiver (M2): polls the PUBLIC channel pointer, verifies the
 * release's signed SHA-256SUMS document with the project's published artifact key, and re-renders the
 * formula + cask when the channel moved. Zero dependencies (Node >= 18). Never bumps on unverified input.
 *
 * The verification chain replicates the source repository's release-signature gate exactly
 * (scripts/lib/release-signature.ts in reality-connect/new-seed): the Tauri 4-line Minisign .sig text,
 * key-id agreement, the Ed25519 artifact signature (prehashed = blake2b-512 of the document) and the
 * global signature over signature || trusted-comment content. The SHA-256SUMS document is signed with
 * the ARTIFACT signing key (release.signingPublicKey) — the same key that signs every artifact — not
 * the TUF-lite channel-metadata key (release.manifestSigningPublicKey, for channel.json.sig, disabled).
 * The key is embedded here as scripts/signing.pub (public material; the source repo is private, so the
 * tap cannot fetch it credential-free — rotation is an explicit, reviewable tap PR).
 *
 * The rendered files mirror the source repository's generator (scripts/lib/release-homebrew.ts) byte
 * for byte, so a bump is exactly what the generator would have emitted for the same inputs.
 *
 * stdout contract (machine-readable, emitted last):
 *   STATUS=current <version>   the tap already serves the channel version (no change)
 *   STATUS=updated <version>   the formula/cask were re-rendered for the channel version
 *   VERSION=<version>          the channel version (present in both cases)
 * Any verification or validation failure exits non-zero BEFORE anything is written.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// ── Project identity (this tap serves exactly this project; see README.md) ─────────────
const PUBLISHER = 'reality-connect/releases'; // public publisher repo holding the releases + channel pointer
const PROJECT_SLUG = 'new-seed'; // the <project>-v<version> release tag prefix
const CHANNEL = 'beta'; // the channel this tap tracks
const HOMEPAGE = 'https://github.com/reality-connect/new-seed';
const CHANNEL_POINTER = `https://github.com/${PUBLISHER}/releases/download/${PROJECT_SLUG}-channel-${CHANNEL}/${CHANNEL}.json`;

// The formula/cask surfaces — the same closed shapes the source generator serves.
const FORMULA_PATH = 'Formula/seed.rb';
const CASK_PATH = 'Casks/seed-desktop.rb';
const FORMULA_CLI_TARGETS = [
  { target: 'darwin-aarch64', arch: 'arm', os: 'mac' },
  { target: 'darwin-x86_64', arch: 'intel', os: 'mac' },
  { target: 'linux-x86_64-gnu', arch: null, os: 'linux' },
];
const CASK_DMG_ARCHES = ['darwin-aarch64', 'darwin-x86_64'];
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
// The GNU sha256sum --check line: 64 lowercase hex, TWO spaces, safe asset name.
const CHECKSUMS_LINE_PATTERN = /^([0-9a-f]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/;

const versionTag = (version) => `${PROJECT_SLUG}-v${version}`;
const releaseBase = (version) => `https://github.com/${PUBLISHER}/releases/download/${versionTag(version)}`;
const versionInterpolatedUrl = (asset) => `https://github.com/${PUBLISHER}/releases/download/${PROJECT_SLUG}-v#{version}/${asset}`;

function fail(message) {
  console.error(`auto-update: ${message}`);
  process.exit(1);
}

// ── Minisign parsing (mirrors @seed/common/release parse/decode helpers) ────────────────
function decodeBase64(value) {
  try {
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}
function minisignLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function parseMinisignPublicKey(text) {
  const lines = minisignLines(text);
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment:')) return null;
  const blob = decodeBase64(lines[1]);
  if (blob === null || blob.length !== 42 || blob[0] !== 0x45 || blob[1] !== 0x64) return null;
  return { keyId: Buffer.from(blob.slice(2, 10)).toString('hex'), key: blob.slice(10) };
}
function parseMinisignSignature(text) {
  const lines = minisignLines(text);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment:')) return null;
  const blob = decodeBase64(lines[1]);
  const globalBlob = decodeBase64(lines[3]);
  if (blob === null || blob.length !== 74 || !(blob[0] === 0x45 && (blob[1] === 0x64 || blob[1] === 0x44))) return null;
  if (globalBlob === null || globalBlob.length !== 64) return null;
  return {
    keyId: Buffer.from(blob.slice(2, 10)).toString('hex'),
    prehashed: blob[1] === 0x44,
    signature: blob.slice(10),
    globalSignature: globalBlob,
    trustedComment: lines[2],
  };
}
function decodeTauriSignature(outer) {
  const bytes = decodeBase64(outer.trim());
  if (bytes === null) return null;
  return parseMinisignSignature(Buffer.from(bytes).toString('utf8'));
}
const blake2b512 = (data) => new Uint8Array(createHash('blake2b512').update(data).digest());

/** The exact verifyTauriSignature chain (release-signature.ts): false on any mismatch, never throws. */
async function verifyTauriSignature(publicKey, signature, data) {
  const key = parseMinisignPublicKey(publicKey);
  const parsed = decodeTauriSignature(signature);
  if (key === null || parsed === null || key.keyId !== parsed.keyId) return false;
  const imported = await crypto.subtle.importKey('raw', key.key, { name: 'Ed25519' }, false, ['verify']);
  const message = parsed.prehashed ? blake2b512(data) : data;
  if (!(await crypto.subtle.verify({ name: 'Ed25519' }, imported, parsed.signature, message))) return false;
  const content = parsed.trustedComment.startsWith('trusted comment: ')
    ? parsed.trustedComment.slice('trusted comment: '.length)
    : parsed.trustedComment;
  const contentBytes = new TextEncoder().encode(content);
  const global = new Uint8Array(parsed.signature.length + contentBytes.length);
  global.set(parsed.signature, 0);
  global.set(contentBytes, parsed.signature.length);
  return crypto.subtle.verify({ name: 'Ed25519' }, imported, parsed.globalSignature, global);
}

// ── Fetching ────────────────────────────────────────────────────────────────────────────
async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'homebrew-tap-auto-update' },
    signal: AbortSignal.timeout(30000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response.text();
}

/** The signed channel pointer (public URL — no credentials involved). */
async function fetchChannelManifest() {
  const text = await fetchText(CHANNEL_POINTER);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('the channel pointer is not valid JSON');
  }
  if (typeof manifest !== 'object' || manifest === null || typeof manifest.version !== 'string') {
    throw new Error('the channel pointer lacks a version');
  }
  return manifest;
}

/**
 * The project's PUBLISHED artifact public key — the trust anchor of this tap, embedded here as
 * `scripts/signing.pub` (public material, the same key every artifact and the SHA-256SUMS document are
 * signed with). The key cannot be fetched at runtime: it lives in the PRIVATE source repository
 * (reality-connect/new-seed, project.yaml `release.signingPublicKey`) and a tap-scoped GITHUB_TOKEN has
 * no access to it — embedding is the only credential-free option, and it makes rotation an explicit,
 * reviewable tap PR.
 */
function readSigningPublicKey() {
  let text;
  try {
    text = readFileSync('scripts/signing.pub', 'utf8');
  } catch {
    fail('scripts/signing.pub is missing (the published artifact key must be committed)');
  }
  const key = parseMinisignPublicKey(text);
  if (key === null) {
    fail('scripts/signing.pub is not a valid 2-line Minisign public key');
  }
  return text.trim();
}

/** The release's signed checksums document pair (public URLs). */
async function fetchChecksums(version) {
  const base = releaseBase(version);
  const document = await fetchText(`${base}/SHA-256SUMS`);
  const signature = (await fetchText(`${base}/SHA-256SUMS.sig`)).trim();
  return { document, signature };
}

/** Strict parse of the checksums document (release-publish.ts parseChecksumsDocument semantics). */
function parseChecksums(document) {
  const entries = {};
  const lines = document.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const match = CHECKSUMS_LINE_PATTERN.exec(line);
    if (match === null) throw new Error('the checksums document carries a malformed entry');
    entries[match[2]] = match[1];
  }
  if (Object.keys(entries).length === 0) throw new Error('the checksums document carries no entries');
  return entries;
}

// ── Rendering (byte-for-byte the source generator's templates) ─────────────────────────
function classCase(name) {
  return name.replace(/(^|-)([a-z])/g, (_, __, letter) => letter.toUpperCase());
}
function renderFormula(version, blocks) {
  const mac = blocks.filter((block) => block.os === 'mac');
  const arm = mac.find((block) => block.arch === 'arm');
  const intel = mac.find((block) => block.arch === 'intel');
  const linux = blocks.find((block) => block.os === 'linux');
  if (arm === undefined || intel === undefined || linux === undefined) {
    throw new Error('the formula requires the darwin arm64, darwin x86_64 and linux x86_64 CLI assets');
  }
  const lines = [
    `class ${classCase('seed')} < Formula`,
    `  desc "Command-line interface for the ${PROJECT_SLUG} project"`,
    `  homepage "${HOMEPAGE}"`,
    `  version "${version}"`,
    '',
    '  if OS.mac?',
    '    if Hardware::CPU.arm?',
    `      url "${arm.url}"`,
    `      sha256 "${arm.sha256}"`,
    '    else',
    `      url "${intel.url}"`,
    `      sha256 "${intel.sha256}"`,
    '    end',
    '  else',
    `    url "${linux.url}"`,
    `    sha256 "${linux.sha256}"`,
    '  end',
    '',
    '  def install',
    '    bin.install File.basename(url) => "seed"',
    '  end',
    'end',
  ];
  return `${lines.join('\n')}\n`;
}
function renderCask(version, digests) {
  const arm = digests.find((entry) => entry.arch === 'darwin-aarch64')?.sha256;
  const intel = digests.find((entry) => entry.arch === 'darwin-x86_64')?.sha256;
  if (arm === undefined || intel === undefined) {
    throw new Error('the cask requires both darwin DMG digests');
  }
  const lines = [
    'cask "seed-desktop" do',
    '  arch arm: "aarch64", intel: "x86_64"',
    '',
    `  version "${version}"`,
    `  sha256 arm:   "${arm}",`,
    `         intel: "${intel}"`,
    '',
    `  url "${versionInterpolatedUrl('darwin-#{arch}.dmg')}"`,
    '  name "Seed Desktop"',
    `  desc "Desktop app for the ${PROJECT_SLUG} project"`,
    `  homepage "${HOMEPAGE}"`,
    '',
    '  depends_on :macos',
    '',
    '  app "Seed Desktop.app"',
    'end',
  ];
  return `${lines.join('\n')}\n`;
}

// ── The receiver ────────────────────────────────────────────────────────────────────────
const manifest = await fetchChannelManifest().catch((error) => fail(error.message));
const version = manifest.version;
if (!VERSION_PATTERN.test(version)) fail(`the channel version is not a valid version: ${version}`);
console.error(`auto-update: channel ${CHANNEL} points at ${version}`);

const publicKey = readSigningPublicKey();
const { document, signature } = await fetchChecksums(version).catch((error) => fail(error.message));
if (!(await verifyTauriSignature(publicKey, signature, new TextEncoder().encode(document)))) {
  fail('the SHA-256SUMS signature does not verify against the published signing key; refusing to bump');
}
console.error('auto-update: SHA-256SUMS signature verified against the published artifact key');
const checksums = (() => {
  try {
    return parseChecksums(document);
  } catch (error) {
    fail(error.message);
  }
})();

// Every needed asset must exist in BOTH the manifest (URLs) and the checksums (digests), agree, and
// live at a canonical version-release URL — mirroring generateHomebrewTap's value-free refusal.
const base = releaseBase(version);
const blocks = [];
for (const { target, arch, os } of FORMULA_CLI_TARGETS) {
  const asset = manifest.cli?.[target];
  if (asset === undefined || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string') {
    fail(`the channel manifest lacks the ${target} CLI asset`);
  }
  if (asset.url !== `${base}/cli-${target}`) {
    fail(`the channel manifest carries a non-canonical ${target} CLI asset URL`);
  }
  const digest = checksums[`cli-${target}`];
  if (digest === undefined) fail(`the checksums document lacks the ${target} CLI asset`);
  if (digest !== asset.sha256) fail('the checksums document disagrees with the channel manifest on a CLI asset digest');
  blocks.push({ arch, os, url: versionInterpolatedUrl(`cli-${target}`), sha256: digest });
}
const caskDigests = [];
for (const arch of CASK_DMG_ARCHES) {
  const digest = checksums[`${arch}.dmg`];
  if (digest === undefined) fail(`the checksums document lacks the ${arch} DMG installer`);
  caskDigests.push({ arch, sha256: digest });
}

// Compare against the currently served version.
let current = null;
try {
  const formula = readFileSync(FORMULA_PATH, 'utf8');
  const match = /^  version "([^"]+)"$/m.exec(formula);
  if (match !== null) current = match[1];
} catch {
  current = null;
}
console.error(`auto-update: tap currently serves ${current ?? '(unknown)'}`);

if (current === version) {
  console.log(`STATUS=current ${version}`);
  console.log(`VERSION=${version}`);
  process.exit(0);
}

const formulaText = renderFormula(version, blocks);
const caskText = renderCask(version, caskDigests);
writeFileSync(FORMULA_PATH, formulaText);
writeFileSync(CASK_PATH, caskText);
console.error(`auto-update: re-rendered ${FORMULA_PATH} and ${CASK_PATH} for ${version}`);
console.log(`STATUS=updated ${version}`);
console.log(`VERSION=${version}`);
