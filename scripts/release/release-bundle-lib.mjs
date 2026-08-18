import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, posix, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const RELEASE_VERSION = "0.4.0-rc.1";
export const RELEASE_BASENAME = `xero-accounting-mcp-${RELEASE_VERSION}-source`;
export const RELEASE_ROOT = `xero-accounting-mcp-${RELEASE_VERSION}`;
export const DEFAULT_SOURCE_DATE_EPOCH = 0;

const LEGACY_PERSONAL_DOMAIN = ["offbeatlab", "fun"].join(".");
const REQUIRED_MIGRATIONS_MANIFEST_PATH = "src/db/required-migrations.json";

function loadRequiredMigrationReleaseFiles() {
  const manifest = JSON.parse(readFileSync(
    new URL("../../src/db/required-migrations.json", import.meta.url),
    "utf8",
  ));
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.requiredMigrations) ||
    manifest.requiredMigrations.length === 0 ||
    manifest.requiredMigrations.some((migration) =>
      typeof migration !== "string" || !/^\d{3}_[a-z0-9_]+\.sql$/u.test(migration)
    ) ||
    new Set(manifest.requiredMigrations).size !== manifest.requiredMigrations.length
  ) {
    throw new Error("The required migrations manifest is invalid.");
  }
  return Object.freeze(manifest.requiredMigrations.map((migration) => `migrations/${migration}`));
}

const REQUIRED_MIGRATION_RELEASE_FILES = loadRequiredMigrationReleaseFiles();

const EXACT_RELEASE_FILES = [
  ".dockerignore",
  ".gitignore",
  "README.md",
  "package-lock.json",
  "package.json",
  "tsconfig.build.json",
  "tsconfig.json",
  "config/.env.example",
  "config/tool-allowlist.json",
  "deploy/Dockerfile",
  "deploy/Dockerfile.dockerignore",
  "deploy/HETZNER-HOST-NGINX-RUNBOOK.md",
  "deploy/HETZNER_RUNBOOK.md",
  "deploy/env.vps.example",
  "scripts/copy-oauth-assets.mjs",
  "scripts/preflight_xero_duplicate_guards.sql",
  "scripts/local-acceptance-contract.mjs",
  "scripts/approved-local-builder-contract.mjs",
  "scripts/verify-accepted-build-context.mjs",
  "scripts/verify-accepted-oci-release.mjs",
  "scripts/release/production-deployment-admission.mjs",
  "scripts/release/production-deployment-contract.mjs",
  "tests/contract/expected-tools.json",
];

const RELEASE_DIRECTORIES = [
  "deploy/docker-compose",
  "deploy/host-nginx",
  "deploy/nginx",
  "deploy/scripts",
  "migrations",
  "src",
];

const REQUIRED_RELEASE_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.build.json",
  "config/.env.example",
  "src/oauth/assets/xero-logo.png",
  "src/oauth/assets/zcloak-app-icon.png",
  "src/server.ts",
  "src/xeroRelease.ts",
  REQUIRED_MIGRATIONS_MANIFEST_PATH,
  "migrations/001_init.sql",
  "migrations/020_xero_runtime_readiness_compatibility.sql",
  ...REQUIRED_MIGRATION_RELEASE_FILES,
  "deploy/Dockerfile",
  "deploy/HETZNER-HOST-NGINX-RUNBOOK.md",
  "deploy/env.vps.example",
  "deploy/docker-compose/compose.host-nginx.green.vps.yaml",
  "deploy/scripts/verify-static.sh",
  "scripts/copy-oauth-assets.mjs",
  "scripts/preflight_xero_duplicate_guards.sql",
  "scripts/local-acceptance-contract.mjs",
  "scripts/approved-local-builder-contract.mjs",
  "scripts/verify-accepted-build-context.mjs",
  "scripts/verify-accepted-oci-release.mjs",
  "scripts/release/production-deployment-admission.mjs",
  "scripts/release/production-deployment-contract.mjs",
  "tests/contract/expected-tools.json",
];

const ALLOWED_PNG_RELEASE_FILES = new Set([
  "src/oauth/assets/xero-logo.png",
  "src/oauth/assets/zcloak-app-icon.png",
]);

const ALLOWED_PRODUCTION_RELEASE_TOOLS = new Set([
  "scripts/release/production-deployment-admission.mjs",
  "scripts/release/production-deployment-contract.mjs",
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const FORBIDDEN_DIRECTORY_SEGMENTS = new Set([
  ".git",
  ".playwright-cli",
  ".playwright-mcp",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "test-results",
  "tmp",
  "uat",
]);

const FORBIDDEN_PRIVATE_FILE_EXTENSIONS = new Set([
  ".crt",
  ".der",
  ".jks",
  ".key",
  ".kdb",
  ".p12",
  ".pem",
  ".pfx",
]);

const SECRET_PATTERNS = [
  {
    id: "PRIVATE_KEY_BLOCK",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  {
    id: "AWS_ACCESS_KEY",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  },
  {
    id: "GITHUB_TOKEN",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  },
  {
    id: "OPENAI_TOKEN",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    id: "SLACK_TOKEN",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  },
  {
    id: "JWT_TOKEN",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  },
];

const LITERAL_SECRET_ASSIGNMENT = /["']?(client[_-]?secret|password|bearer[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|encryption[_-]?key|confirmation[_-]?secret)["']?\s*[:=]\s*(["'])([^"'\r\n]{8,})\2/giu;
const ENV_SECRET_ASSIGNMENT = /^(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY|HASH_KEY)[A-Z0-9_]*)\s*=\s*([^\s#]+)\s*$/gmu;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/giu;

function toPosixPath(path) {
  return path.replaceAll("\\", "/");
}

function assertSafeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\")) {
    throw new Error(`Unsafe release path: ${JSON.stringify(path)}`);
  }
  if (posix.isAbsolute(path) || posix.normalize(path) !== path) {
    throw new Error(`Release path is not normalized and relative: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Release path contains an unsafe segment: ${path}`);
  }
}

function fileExtension(path) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

export function forbiddenReleasePathReason(relativePath) {
  const path = toPosixPath(relativePath);
  assertSafeRelativePath(path);
  const lowerPath = path.toLowerCase();
  const segments = lowerPath.split("/");
  const name = segments.at(-1) ?? "";
  const allowedPlaceholderEnvironment = lowerPath === "config/.env.example" ||
    lowerPath === "deploy/env.vps.example";
  const allowedContractFixture = lowerPath === "tests/contract/expected-tools.json";

  if (name === ".ds_store" || name.startsWith("._")) {
    return "OS_METADATA";
  }
  if (segments.some((segment) => FORBIDDEN_DIRECTORY_SEGMENTS.has(segment))) {
    return "FORBIDDEN_DIRECTORY";
  }
  if (lowerPath.startsWith("scripts/release/") && !ALLOWED_PRODUCTION_RELEASE_TOOLS.has(lowerPath)) {
    return "LOCAL_RELEASE_TOOLING";
  }
  if (!allowedPlaceholderEnvironment &&
    (name === ".env" || name.startsWith(".env.") || name.endsWith(".local") || name.includes(".local."))) {
    return "LOCAL_ENV_OR_CONFIG";
  }
  if (lowerPath === "deploy/.env.vps") {
    return "DEPLOY_ENV";
  }
  if (FORBIDDEN_PRIVATE_FILE_EXTENSIONS.has(fileExtension(lowerPath))) {
    return "PRIVATE_KEY_OR_CERTIFICATE";
  }
  if (!allowedContractFixture &&
    (lowerPath.endsWith(".test.ts") || lowerPath.endsWith(".test.js") || lowerPath.startsWith("tests/"))) {
    return "TEST_ONLY_FILE";
  }
  if (lowerPath.includes(LEGACY_PERSONAL_DOMAIN)) {
    return "LEGACY_PERSONAL_DOMAIN_CONFIG";
  }
  return undefined;
}

function isAllowedPlaceholder(value) {
  const normalized = value.trim();
  return normalized.startsWith("${") ||
    normalized.startsWith("$") ||
    normalized.startsWith("<") ||
    /^(?:REPLACE|EXAMPLE|DUMMY|TEST|SYNTHETIC|NOT_SET|CHANGE_ME|PROCESS\.ENV)/iu.test(normalized) ||
    /(?:^|[_-])(?:REPLACE|CHANGE[-_]?ME|PLACEHOLDER)(?:[_-]|$)/iu.test(normalized) ||
    /^(?:[a-z0-9]+-)*concurrency(?:-[a-z0-9]+)*$/iu.test(normalized) ||
    /^[A-Z][A-Z0-9_]+$/u.test(normalized);
}

export function scanReleaseContent(relativePath, content) {
  const findings = [];
  if (!Buffer.isBuffer(content)) throw new TypeError("Release content must be a Buffer.");
  if (!isUtf8(content)) {
    if (ALLOWED_PNG_RELEASE_FILES.has(relativePath) && content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return findings;
    }
    findings.push({ path: relativePath, rule: "NON_UTF8_OR_BINARY_FILE" });
    return findings;
  }

  const text = content.toString("utf8");
  if (text.toLowerCase().includes(LEGACY_PERSONAL_DOMAIN)) {
    findings.push({ path: relativePath, rule: "LEGACY_PERSONAL_DOMAIN" });
  }
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) findings.push({ path: relativePath, rule: rule.id });
  }
  CREDENTIAL_URL.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_URL)) {
    const password = match[1] ?? "";
    if (!isAllowedPlaceholder(password)) {
      findings.push({ path: relativePath, rule: "CREDENTIAL_IN_URL" });
      break;
    }
  }

  LITERAL_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(LITERAL_SECRET_ASSIGNMENT)) {
    const value = match[3] ?? "";
    if (!isAllowedPlaceholder(value)) {
      findings.push({ path: relativePath, rule: "HARDCODED_SECRET_ASSIGNMENT" });
      break;
    }
  }

  ENV_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(ENV_SECRET_ASSIGNMENT)) {
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (/(?:^|_)TOKEN_TTL(?:_|$)|(?:^|_)TTL_SECONDS$/u.test(key)) continue;
    if (!isAllowedPlaceholder(value)) {
      findings.push({ path: relativePath, rule: "POPULATED_SECRET_ENV_ASSIGNMENT" });
      break;
    }
  }
  return findings;
}

async function collectDirectoryFiles(repoRoot, relativeDirectory, output) {
  const absoluteDirectory = resolve(repoRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relativePath = posix.join(relativeDirectory, entry.name);
    const reason = forbiddenReleasePathReason(relativePath);
    if (reason) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in a release bundle: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await collectDirectoryFiles(repoRoot, relativePath, output);
    } else if (entry.isFile()) {
      output.add(relativePath);
    } else {
      throw new Error(`Unsupported filesystem entry in release selection: ${relativePath}`);
    }
  }
}

export async function enumerateReleaseFiles(repoRoot) {
  const selected = new Set();
  for (const relativePath of EXACT_RELEASE_FILES) {
    const stat = await lstat(resolve(repoRoot, relativePath));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Required release input is not a regular file: ${relativePath}`);
    }
    const reason = forbiddenReleasePathReason(relativePath);
    if (reason) throw new Error(`Required release input is forbidden (${reason}): ${relativePath}`);
    selected.add(relativePath);
  }
  for (const relativeDirectory of RELEASE_DIRECTORIES) {
    await collectDirectoryFiles(repoRoot, relativeDirectory, selected);
  }
  const files = [...selected].sort((left, right) => left.localeCompare(right, "en"));
  assertRequiredReleaseFiles(selected);
  return files;
}

export function assertRequiredReleaseFiles(selected) {
  const selectedPaths = selected instanceof Set ? selected : new Set(selected);
  for (const required of REQUIRED_RELEASE_FILES) {
    if (!selectedPaths.has(required)) throw new Error(`Release selection omitted required file: ${required}`);
  }
}

export function normalizedMode(statMode) {
  return (statMode & 0o111) === 0 ? 0o644 : 0o755;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function writeString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`Tar header value is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid tar numeric value: ${value}`);
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  if (encoded.length > length) throw new Error(`Tar numeric value is too large: ${value}`);
  writeString(buffer, offset, length, encoded);
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const slashIndexes = [];
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === "/") slashIndexes.push(index);
  }
  for (const slash of slashIndexes.reverse()) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Release path does not fit the ustar header: ${path}`);
}

function tarHeader(path, size, mode, mtime) {
  const header = Buffer.alloc(512, 0);
  const split = splitTarPath(path);
  writeString(header, 0, 100, split.name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function createDeterministicTar(entries, options = {}) {
  const sourceDateEpoch = options.sourceDateEpoch ?? DEFAULT_SOURCE_DATE_EPOCH;
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error("sourceDateEpoch must be a non-negative integer.");
  }
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const seen = new Set();
  const chunks = [];
  for (const entry of sorted) {
    assertSafeRelativePath(entry.path);
    if (seen.has(entry.path)) throw new Error(`Duplicate tar path: ${entry.path}`);
    seen.add(entry.path);
    if (!Buffer.isBuffer(entry.content)) throw new TypeError(`Tar content must be a Buffer: ${entry.path}`);
    chunks.push(tarHeader(entry.path, entry.content.length, entry.mode, sourceDateEpoch));
    chunks.push(entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function createDeterministicTarGz(entries, options = {}) {
  return gzipSync(createDeterministicTar(entries, options), { level: 9, mtime: 0 });
}

function readTarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul >= 0 ? nul : field.length).toString("utf8");
}

function readTarOctal(header, offset, length, fieldName) {
  const value = readTarString(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error(`Invalid tar ${fieldName}: ${JSON.stringify(value)}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Tar ${fieldName} exceeds the safe integer range.`);
  return parsed;
}

function isZeroBlock(block) {
  return block.length === 512 && block.every((byte) => byte === 0);
}

function parseTarBuffer(tar, options = {}) {
  const maxExpandedBytes = options.maxExpandedBytes ?? 128 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 10_000;
  if (!Buffer.isBuffer(tar)) throw new TypeError("Tar archive must be a Buffer.");
  if (tar.length > maxExpandedBytes) throw new Error(`Expanded archive exceeds ${maxExpandedBytes} bytes.`);
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let endMarkerSeen = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      const second = tar.subarray(offset + 512, offset + 1024);
      if (!isZeroBlock(second)) throw new Error("Tar archive has only one zero end block.");
      if (!tar.subarray(offset + 1024).every((byte) => byte === 0)) {
        throw new Error("Tar archive has non-zero data after its end marker.");
      }
      endMarkerSeen = true;
      break;
    }

    const storedChecksum = readTarOctal(header, 148, 8, "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const calculatedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== calculatedChecksum) throw new Error("Tar header checksum mismatch.");

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafeRelativePath(path);
    if (seen.has(path)) throw new Error(`Duplicate archive entry: ${path}`);
    seen.add(path);
    const type = header[156];
    if (type !== 0 && type !== "0".charCodeAt(0)) {
      throw new Error(`Only regular files are allowed in the release archive: ${path}`);
    }
    const size = readTarOctal(header, 124, 12, "size");
    const mode = readTarOctal(header, 100, 8, "mode");
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error(`Truncated tar entry: ${path}`);
    entries.push({ path, size, mode, content: Buffer.from(tar.subarray(contentStart, contentEnd)) });
    if (entries.length > maxEntries) throw new Error(`Archive exceeds ${maxEntries} entries.`);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (!endMarkerSeen) throw new Error("Tar archive is missing its two-block end marker.");
  return entries;
}

export function parseTarArchive(tar, options = {}) {
  return parseTarBuffer(tar, options);
}

export function parseDeterministicTarGz(archive, options = {}) {
  const maxArchiveBytes = options.maxArchiveBytes ?? 64 * 1024 * 1024;
  const maxExpandedBytes = options.maxExpandedBytes ?? 128 * 1024 * 1024;
  if (!Buffer.isBuffer(archive)) throw new TypeError("Archive must be a Buffer.");
  if (archive.length > maxArchiveBytes) throw new Error(`Archive exceeds ${maxArchiveBytes} bytes.`);
  const tar = gunzipSync(archive, { maxOutputLength: maxExpandedBytes });
  return parseTarBuffer(tar, options);
}

export function requiredReleaseFiles() {
  return [...REQUIRED_RELEASE_FILES];
}

export function requiredMigrationReleaseFiles() {
  return [...REQUIRED_MIGRATION_RELEASE_FILES];
}
