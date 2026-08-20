import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import {
  contentAddressedReviewChunks,
  captureIndependentReviewInputs,
  independentReviewSubjectSha256,
  reviewContentBatches,
  reviewSha256,
  REVIEW_SHARD_MAX_BATCH_COUNT,
  REVIEW_SHARD_MAX_FILE_COUNT,
  REVIEW_SHARD_MAX_TOTAL_BYTES,
  REVIEW_CONTENT_BATCH_OUTPUT_JSON_BYTES,
  stableReviewStringify,
} from "./independent-review-evidence-lib.mjs";

const typescriptRuntimeCache = new Map();

const REVIEW_SHARD_MAX_EDGE_COUNT = 24;
const REVIEW_SHARD_MAX_PROBE_COUNT = 1;
const REVIEW_SHARD_ADMISSION_TOKEN_LIMIT = 360_000;
const REVIEW_PLAN_MAX_SHARD_COUNT = 192;
const REVIEW_PLAN_MAX_DUPLICATED_TOTAL_BYTES = 32 * 1024 * 1024;
export const INDEPENDENT_REVIEW_MODEL = "gpt-5.6-sol";
export const INDEPENDENT_REVIEW_REASONING_EFFORT = "xhigh";
export const INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT = 400_000;
const REVIEW_SYSTEM_AND_TOOL_TOKEN_RESERVE = 64 * 1024;
/**
 * The admission limit is denominated in tokens, but the payload is measured in
 * bytes, so the two were being compared directly — one byte counted as one
 * token. For the TypeScript in this repository a token is closer to three and a
 * half bytes, which made the estimate roughly quadruple the truth and pushed
 * the largest and most safety-critical file, src/db/postgresRepository.ts at
 * ~444 KiB, past a budget it comfortably fits inside. The effect was that the
 * review could not admit the very file where the reservation and binding guards
 * live, and it got worse as the code grew.
 *
 * Two rather than three and a half: still well under the real ratio, so the
 * estimate stays deliberately pessimistic and a shard cannot overrun the
 * reviewer's context, while no longer rejecting content that fits. The byte
 * ceilings below are unchanged and remain authoritative.
 */
const REVIEW_CONSERVATIVE_BYTES_PER_TOKEN = 2;
const REVIEW_OUTPUT_TOKEN_RESERVE = 32 * 1024;
const REVIEW_PROMPT_AND_ENVELOPE_BYTE_RESERVE = 16 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && /\S/u.test(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function directedClaimWitness({ graph, corePaths, implementationPaths, consumerPaths }) {
  const edgeByTuple = new Map(graph.edges.map((edge) =>
    [`${edge.importer}\0${edge.dependency}`, edge]));
  const dependencies = graph.dependencies;
  const implementationSet = new Set(implementationPaths);
  const witnessPaths = new Set(corePaths);
  const witnessEdges = new Map();

  function shortestPathToImplementation(origin, exactImplementation) {
    if (implementationSet.has(origin) &&
        (exactImplementation === undefined || origin === exactImplementation)) return [origin];
    const queue = [origin];
    const prior = new Map([[origin, null]]);
    let target;
    while (queue.length > 0 && target === undefined) {
      const current = queue.shift();
      for (const dependency of [...(dependencies.get(current) ?? [])]
        .sort((left, right) => left.localeCompare(right, "en"))) {
        if (prior.has(dependency)) continue;
        prior.set(dependency, current);
        if (exactImplementation === undefined
          ? implementationSet.has(dependency)
          : dependency === exactImplementation) {
          target = dependency;
          break;
        }
        queue.push(dependency);
      }
    }
    if (target === undefined) return undefined;
    const reversed = [target];
    let current = target;
    while (prior.get(current) !== null) {
      current = prior.get(current);
      reversed.push(current);
    }
    return reversed.reverse();
  }

  // A cited positive/negative test or production consumer is the behavioral
  // end of the claim. It must have a directed import path to a cited
  // implementation anchor; otherwise the citation set cannot demonstrate
  // that the test/consumer exercises the claimed control.
  for (const consumer of sortedUnique(consumerPaths)) {
    const path = shortestPathToImplementation(consumer);
    if (!path) {
      throw new Error(`INDEPENDENT_REVIEW_CLAIM_DIRECTED_WITNESS_MISSING:${consumer}`);
    }
    for (const vertex of path) witnessPaths.add(vertex);
    for (let index = 0; index < path.length - 1; index += 1) {
      const edge = edgeByTuple.get(`${path[index]}\0${path[index + 1]}`);
      if (!edge) throw new Error("INDEPENDENT_REVIEW_CLAIM_DIRECTED_WITNESS_EDGE_MISSING");
      witnessEdges.set(edgeId(edge), edge);
    }
  }

  for (const implementation of sortedUnique(implementationPaths)) {
    const candidates = sortedUnique(consumerPaths).map((consumer) =>
      shortestPathToImplementation(consumer, implementation)).filter(Boolean)
      .sort((left, right) => left.length - right.length ||
        left.join("\0").localeCompare(right.join("\0"), "en"));
    const path = candidates[0];
    if (!path) {
      throw new Error(`INDEPENDENT_REVIEW_IMPLEMENTATION_DIRECTED_WITNESS_MISSING:${implementation}`);
    }
    for (const vertex of path) witnessPaths.add(vertex);
    for (let index = 0; index < path.length - 1; index += 1) {
      const edge = edgeByTuple.get(`${path[index]}\0${path[index + 1]}`);
      if (!edge) throw new Error("INDEPENDENT_REVIEW_IMPLEMENTATION_DIRECTED_WITNESS_EDGE_MISSING");
      witnessEdges.set(edgeId(edge), edge);
    }
  }

  // Follow only outgoing dependencies from the implementation core. Never
  // walk consumers here: reverse traversal would pull unrelated sibling D
  // merely because D imports a shared helper H used by this claim.
  const queue = sortedUnique(implementationPaths);
  const forwardVisited = new Set(queue);
  while (queue.length > 0) {
    const importer = queue.shift();
    witnessPaths.add(importer);
    for (const dependency of [...(dependencies.get(importer) ?? [])]
      .sort((left, right) => left.localeCompare(right, "en"))) {
      const edge = edgeByTuple.get(`${importer}\0${dependency}`);
      if (!edge) throw new Error("INDEPENDENT_REVIEW_CLAIM_FORWARD_EDGE_MISSING");
      witnessEdges.set(edgeId(edge), edge);
      witnessPaths.add(dependency);
      if (!forwardVisited.has(dependency)) {
        forwardVisited.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return {
    paths: sortedUnique([...witnessPaths]),
    edges: [...witnessEdges.values()].sort((left, right) =>
      edgeId(left).localeCompare(edgeId(right), "en")),
  };
}

async function frozenTypescriptRuntime(repoRoot) {
  const canonicalRoot = await realpath(repoRoot);
  if (!typescriptRuntimeCache.has(canonicalRoot)) {
    const runtimeRequire = createRequire(resolve(canonicalRoot, "package.json"));
    const modulePath = runtimeRequire.resolve("typescript");
    const moduleRelative = relative(resolve(canonicalRoot, "node_modules"), modulePath);
    if (!moduleRelative || moduleRelative === ".." || moduleRelative.startsWith(`..${sep}`) ||
        isAbsolute(moduleRelative)) {
      throw new Error(
        `INDEPENDENT_REVIEW_TYPESCRIPT_RUNTIME_OUTSIDE_FROZEN_ROOT:${modulePath}:${canonicalRoot}`,
      );
    }
    // Resolve and execute TypeScript through the frozen root's require graph.
    // Dynamic import makes Vitest transform the multi-megabyte runtime for
    // every content-addressed fixture; require keeps resolution rooted at the
    // already-verified snapshot and uses Node's exact CJS loader instead.
    typescriptRuntimeCache.set(canonicalRoot, runtimeRequire(modulePath));
  }
  const module = typescriptRuntimeCache.get(canonicalRoot);
  const ts = module.default ?? module;
  if (typeof ts.createSourceFile !== "function") {
    throw new Error("INDEPENDENT_REVIEW_TYPESCRIPT_RUNTIME_INVALID");
  }
  return ts;
}

function typescriptScriptKind(ts, path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:mts|mjs)$/u.test(path)) return ts.ScriptKind.TS;
  if (/\.(?:cts|cjs)$/u.test(path)) return ts.ScriptKind.TS;
  if (path.endsWith(".json")) return ts.ScriptKind.JSON;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function semanticBoundaryOffsets(ts, path, content) {
  if (!/\.(?:[cm]?[jt]sx?|json)$/u.test(path)) return [0, content.length];
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) return [0, content.length];
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    typescriptScriptKind(ts, path),
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`INDEPENDENT_REVIEW_SEMANTIC_PARSE_FAILED:${path}`);
  }
  const characterOffsets = new Set([0, text.length]);
  for (const statement of source.statements) {
    characterOffsets.add(statement.getFullStart());
    if (Array.isArray(statement.members)) {
      for (const member of statement.members) characterOffsets.add(member.getFullStart());
      characterOffsets.add(statement.end);
    }
  }
  const byteOffsets = [...characterOffsets].map((offset) => Buffer.byteLength(text.slice(0, offset), "utf8"));
  return [...new Set(byteOffsets)].sort((left, right) => left - right);
}

function semanticUnitsForFile(ts, path, content) {
  const boundaries = semanticBoundaryOffsets(ts, path, content);
  const ranges = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;
    const bytes = content.subarray(start, end);
    const identity = {
      path,
      start_offset_bytes: start,
      end_offset_bytes: end,
      size_bytes: bytes.length,
      sha256: reviewSha256(bytes),
      boundary_kind: /\.(?:[cm]?[jt]sx?|json)$/u.test(path)
        ? "TYPESCRIPT_AST_SYMBOL_OR_STATEMENT_RANGE"
        : "WHOLE_FILE_RANGE",
    };
    ranges.push({
      ...identity,
      semantic_unit_id: reviewSha256(stableReviewStringify(identity)),
      bytes,
    });
  }
  if (ranges.length === 0) {
    const identity = {
      path,
      start_offset_bytes: 0,
      end_offset_bytes: 0,
      size_bytes: 0,
      sha256: reviewSha256(Buffer.alloc(0)),
      boundary_kind: "EMPTY_FILE_RANGE",
    };
    ranges.push({
      ...identity,
      semantic_unit_id: reviewSha256(stableReviewStringify(identity)),
      bytes: Buffer.alloc(0),
    });
  }
  let transportIndex = 0;
  const transportChunks = [];
  for (const unit of ranges) {
    unit.transport_chunks = contentAddressedReviewChunks(unit.bytes).map((chunk) => {
      const identityContent = {
        chunk_index: transportIndex,
        chunk_count: 0,
        offset_bytes: unit.start_offset_bytes + chunk.offset_bytes,
        size_bytes: chunk.size_bytes,
        sha256: chunk.sha256,
        semantic_unit_id: unit.semantic_unit_id,
      };
      const adjusted = {
        ...chunk,
        ...identityContent,
      };
      transportIndex += 1;
      transportChunks.push(adjusted);
      return adjusted;
    });
  }
  for (const chunk of transportChunks) chunk.chunk_count = transportChunks.length;
  for (const unit of ranges) {
    unit.transport_chunk_ids = unit.transport_chunks.map((chunk) => reviewSha256(stableReviewStringify({
      path,
      chunk_index: chunk.chunk_index,
      chunk_count: chunk.chunk_count,
      offset_bytes: chunk.offset_bytes,
      size_bytes: chunk.size_bytes,
      sha256: chunk.sha256,
      semantic_unit_id: unit.semantic_unit_id,
    })));
  }
  return ranges;
}

function buildSemanticUnitCatalog(ts, identityByPath, contentByPath) {
  const unitsByPath = new Map();
  const unitsById = new Map();
  for (const path of [...identityByPath.keys()].sort((left, right) => left.localeCompare(right, "en"))) {
    const content = contentByPath.get(path);
    if (!Buffer.isBuffer(content)) throw new Error(`INDEPENDENT_REVIEW_PLAN_CAPTURE_MISSING:${path}`);
    const units = semanticUnitsForFile(ts, path, content);
    unitsByPath.set(path, units);
    for (const unit of units) unitsById.set(unit.semantic_unit_id, unit);
  }
  return { unitsByPath, unitsById };
}

function semanticUnitAtOffset(semanticCatalog, path, offset) {
  const units = semanticCatalog.unitsByPath.get(path) ?? [];
  const unit = units.find((candidate) => offset >= candidate.start_offset_bytes &&
    offset < candidate.end_offset_bytes) ?? (offset === 0 ? units[0] : undefined);
  if (!unit) throw new Error(`INDEPENDENT_REVIEW_SEMANTIC_ANCHOR_NOT_FOUND:${path}:${offset}`);
  return unit;
}

function semanticUnitsForTextAnchors(semanticCatalog, path, anchors) {
  const units = semanticCatalog.unitsByPath.get(path) ?? [];
  const selected = [];
  for (const anchor of anchors ?? []) {
    if (!nonEmpty(anchor)) continue;
    const unit = units.find((candidate) => candidate.bytes.toString("utf8").includes(anchor));
    if (unit && !selected.includes(unit)) selected.push(unit);
  }
  if (selected.length === 0) {
    throw new Error(`INDEPENDENT_REVIEW_SEMANTIC_DEPENDENCY_EXPORT_TARGET_NOT_FOUND:${path}`);
  }
  return selected;
}

function semanticUnitForExactAnchor(semanticCatalog, path, anchor, label) {
  if (!nonEmpty(anchor)) throw new Error(`${label}:ANCHOR_INVALID`);
  const units = semanticCatalog.unitsByPath.get(path) ?? [];
  const matches = units.filter((unit) => unit.bytes.toString("utf8").includes(anchor));
  if (matches.length !== 1) throw new Error(`${label}:ANCHOR_NOT_EXACT:${path}:${matches.length}`);
  return matches[0];
}

function semanticUnitForObligationAnchor(semanticCatalog, path, anchor, literal, label) {
  if (!nonEmpty(anchor) || !nonEmpty(literal)) {
    throw new Error(`${label}:ANCHOR_OR_LITERAL_INVALID`);
  }
  const units = semanticCatalog.unitsByPath.get(path) ?? [];
  const matches = units.filter((unit) => {
    const text = unit.bytes.toString("utf8");
    return text.includes(anchor) && text.includes(literal);
  });
  if (matches.length !== 1) {
    throw new Error(`${label}:ANCHOR_LITERAL_NOT_COLOCATED:${path}:${matches.length}`);
  }
  const unit = matches[0];
  const literalBytes = Buffer.from(literal, "utf8");
  const literalOffset = unit.bytes.indexOf(literalBytes);
  if (literalOffset < 0 || unit.bytes.indexOf(literalBytes, literalOffset + 1) !== -1) {
    throw new Error(`${label}:LITERAL_NOT_EXACT_IN_ANCHOR_UNIT:${path}`);
  }
  return {
    unit,
    binding: {
      path,
      anchor,
      literal,
      semantic_unit_id: unit.semantic_unit_id,
      anchor_unit_start_offset_bytes: unit.start_offset_bytes,
      anchor_unit_end_offset_bytes: unit.end_offset_bytes,
      anchor_unit_sha256: unit.sha256,
      mutation_start_offset_bytes: unit.start_offset_bytes + literalOffset,
      mutation_end_offset_bytes: unit.start_offset_bytes + literalOffset + literalBytes.length,
    },
  };
}

function edgeSemanticUnitIds(semanticCatalog, edge) {
  if (!Array.isArray(edge.import_sites) || edge.import_sites.length === 0 || edge.import_sites.some((site) =>
    !Number.isSafeInteger(site.importer_anchor_offset_bytes) || site.importer_anchor_offset_bytes < 0 ||
    !Array.isArray(site.dependency_export_anchors))) {
    throw new Error(`INDEPENDENT_REVIEW_EDGE_IMPORT_SITES_INVALID:${edgeId(edge)}`);
  }
  const selected = [];
  for (const site of edge.import_sites) {
    selected.push(semanticUnitAtOffset(
      semanticCatalog, edge.importer, site.importer_anchor_offset_bytes,
    ).semantic_unit_id);
    if (site.dependency_export_anchors.length > 0) {
      if (/\.json$/u.test(edge.dependency)) {
        selected.push(...(semanticCatalog.unitsByPath.get(edge.dependency) ?? [])
          .map((unit) => unit.semantic_unit_id));
      } else {
        try {
          selected.push(...semanticUnitsForTextAnchors(
            semanticCatalog, edge.dependency, site.dependency_export_anchors,
          ).map((unit) => unit.semantic_unit_id));
        } catch (error) {
          if (!String(error?.message ?? error).startsWith(
            "INDEPENDENT_REVIEW_SEMANTIC_DEPENDENCY_EXPORT_TARGET_NOT_FOUND:",
          )) throw error;
          // Type-only imports may be erased from the dependency's runtime
          // surface or represented by declarations whose exact alias is not
          // textual. Bind the complete declaration module; it is never valid
          // to substitute only its first range.
          selected.push(...(semanticCatalog.unitsByPath.get(edge.dependency) ?? [])
            .map((unit) => unit.semantic_unit_id));
        }
      }
      continue;
    }
    // Side-effect imports have no named export witness. Every top-level
    // executable unit in the dependency is part of the edge contract; a
    // first-unit fallback would silently omit later registration effects.
    selected.push(...(semanticCatalog.unitsByPath.get(edge.dependency) ?? [])
      .map((unit) => unit.semantic_unit_id));
  }
  return sortedUnique(selected);
}

function containedRelative(repoRoot, base, reference, label) {
  const pathPart = reference.split("#", 1)[0];
  const absolute = resolve(base, pathPart);
  const repoRelative = relative(repoRoot, absolute);
  if (!repoRelative || repoRelative === ".." || repoRelative.startsWith(`..${sep}`) ||
      isAbsolute(repoRelative)) {
    throw new Error(`${label}: path escapes the repository: ${reference}`);
  }
  const normalized = repoRelative.replaceAll(sep, "/");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") ||
      posix.normalize(normalized) !== normalized || normalized.includes("\0")) {
    throw new Error(`${label}: unsafe repository-relative path: ${reference}`);
  }
  return normalized;
}

function claimCitationPaths({ claim, repoRoot, documentPath }) {
  const evidenceBase = dirname(resolve(documentPath));
  const paths = [];
  for (const field of ["implementation_files", "positive_tests", "negative_or_mutation_tests"]) {
    if (!Array.isArray(claim[field])) throw new Error(`INDEPENDENT_REVIEW_PLAN_CLAIM_${field.toUpperCase()}_INVALID`);
    for (const reference of claim[field]) {
      paths.push(containedRelative(repoRoot, repoRoot, reference,
        `INDEPENDENT_REVIEW_PLAN:${claim.claim_id}:${field}`));
    }
  }
  if (!Array.isArray(claim.evidence)) throw new Error("INDEPENDENT_REVIEW_PLAN_CLAIM_EVIDENCE_INVALID");
  for (const reference of claim.evidence) {
    const pathPart = reference.split("#", 1)[0];
    paths.push(containedRelative(
      repoRoot,
      pathPart.includes("/") ? repoRoot : evidenceBase,
      pathPart,
      `INDEPENDENT_REVIEW_PLAN:${claim.claim_id}:evidence`,
    ));
  }
  return sortedUnique(paths);
}

function claimFor(document, requirementId, claimId) {
  const requirement = document.requirements?.find((item) => item?.requirement_id === requirementId);
  if (!isRecord(requirement)) throw new Error(`INDEPENDENT_REVIEW_PLAN_REQUIREMENT_MISSING:${requirementId}`);
  const claim = requirement.control_claims?.find((item) => item?.claim_id === claimId);
  if (!isRecord(claim)) throw new Error(`INDEPENDENT_REVIEW_PLAN_CLAIM_MISSING:${claimId}`);
  return { requirement, claim };
}

function edgeId(edge) {
  return edge.id ?? reviewSha256(stableReviewStringify([edge.importer, edge.dependency]));
}

async function materializeSelection(identityByPath, contentByPath, paths) {
  const files = [];
  for (const path of sortedUnique(paths)) {
    const identity = identityByPath.get(path);
    if (!identity) throw new Error(`INDEPENDENT_REVIEW_PLAN_PATH_NOT_IN_UNIVERSE:${path}`);
    const content = contentByPath.get(path);
    if (!Buffer.isBuffer(content)) {
      throw new Error(`INDEPENDENT_REVIEW_PLAN_CAPTURE_MISSING:${path}`);
    }
    if (content.length !== identity.size_bytes || reviewSha256(content) !== identity.sha256) {
      throw new Error(`INDEPENDENT_REVIEW_PLAN_CONTENT_CHANGED:${path}`);
    }
    files.push({ ...identity, content_chunks: contentAddressedReviewChunks(content) });
  }
  return files;
}

async function materializeSemanticUnitSelection(identityByPath, semanticCatalog, semanticUnitIds) {
  const selectedByPath = new Map();
  for (const semanticUnitId of sortedUnique(semanticUnitIds)) {
    const unit = semanticCatalog.unitsById.get(semanticUnitId);
    if (!unit) throw new Error(`INDEPENDENT_REVIEW_SEMANTIC_UNIT_NOT_FOUND:${semanticUnitId}`);
    const selected = selectedByPath.get(unit.path) ?? [];
    selected.push(unit);
    selectedByPath.set(unit.path, selected);
  }
  const files = [];
  for (const path of [...selectedByPath.keys()].sort((left, right) => left.localeCompare(right, "en"))) {
    const identity = identityByPath.get(path);
    if (!identity) throw new Error(`INDEPENDENT_REVIEW_PLAN_PATH_NOT_IN_UNIVERSE:${path}`);
    const units = selectedByPath.get(path).sort((left, right) =>
      left.start_offset_bytes - right.start_offset_bytes);
    const semanticUnitIdentitySha256 = reviewSha256(stableReviewStringify(units.map((unit) => ({
      semantic_unit_id: unit.semantic_unit_id,
      start_offset_bytes: unit.start_offset_bytes,
      end_offset_bytes: unit.end_offset_bytes,
      size_bytes: unit.size_bytes,
      sha256: unit.sha256,
      boundary_kind: unit.boundary_kind,
      transport_chunk_ids: unit.transport_chunk_ids,
    }))));
    files.push({
      path: `${identity.path}#semantic-selection=${semanticUnitIdentitySha256}`,
      size_bytes: identity.size_bytes,
      executable: identity.executable,
      sha256: identity.sha256,
      content_chunks: units.flatMap((unit) => unit.transport_chunks),
    });
  }
  return files;
}

async function capacity(identityByPath, contentByPath, paths, edgeCount = 0, probeCount = 0) {
  const files = await materializeSelection(identityByPath, contentByPath, paths);
  const serializedPayloadBytes = Buffer.byteLength(stableReviewStringify({
    files,
    edge_count: edgeCount,
    probe_count: probeCount,
  }), "utf8") + REVIEW_PROMPT_AND_ENVELOPE_BYTE_RESERVE;
  // The repository admission policy deliberately uses one UTF-8 byte as one
  // input token. This is an upper bound, not a claim about a vendor tokenizer
  // or a model's advertised context window.
  const conservativeInputTokens = REVIEW_SYSTEM_AND_TOOL_TOKEN_RESERVE +
    Math.ceil(serializedPayloadBytes / REVIEW_CONSERVATIVE_BYTES_PER_TOKEN);
  return {
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    batch_count: reviewContentBatches(files).length,
    edge_count: edgeCount,
    probe_count: probeCount,
    review_model: INDEPENDENT_REVIEW_MODEL,
    review_reasoning_effort: INDEPENDENT_REVIEW_REASONING_EFFORT,
    host_context_token_limit: INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT,
    review_shard_admission_token_limit: REVIEW_SHARD_ADMISSION_TOKEN_LIMIT,
    token_estimator: "one-utf8-byte-per-input-token-upper-bound-v1",
    system_and_tool_token_reserve: REVIEW_SYSTEM_AND_TOOL_TOKEN_RESERVE,
    output_token_reserve: REVIEW_OUTPUT_TOKEN_RESERVE,
    serialized_payload_bytes: serializedPayloadBytes,
    conservative_input_tokens: conservativeInputTokens,
    conservative_total_tokens: conservativeInputTokens + REVIEW_OUTPUT_TOKEN_RESERVE,
  };
}

async function semanticCapacity(identityByPath, semanticCatalog, semanticUnitIds, edgeCount = 0, probeCount = 0) {
  const files = await materializeSemanticUnitSelection(identityByPath, semanticCatalog, semanticUnitIds);
  const serializedPayloadBytes = Buffer.byteLength(stableReviewStringify({
    files,
    edge_count: edgeCount,
    probe_count: probeCount,
  }), "utf8") + REVIEW_PROMPT_AND_ENVELOPE_BYTE_RESERVE;
  const conservativeInputTokens = REVIEW_SYSTEM_AND_TOOL_TOKEN_RESERVE +
    Math.ceil(serializedPayloadBytes / REVIEW_CONSERVATIVE_BYTES_PER_TOKEN);
  return {
    file_count: files.length,
    total_bytes: semanticUnitIds.reduce((sum, unitId) =>
      sum + semanticCatalog.unitsById.get(unitId).size_bytes, 0),
    batch_count: reviewContentBatches(files).length,
    semantic_unit_count: semanticUnitIds.length,
    edge_count: edgeCount,
    probe_count: probeCount,
    review_model: INDEPENDENT_REVIEW_MODEL,
    review_reasoning_effort: INDEPENDENT_REVIEW_REASONING_EFFORT,
    host_context_token_limit: INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT,
    review_shard_admission_token_limit: REVIEW_SHARD_ADMISSION_TOKEN_LIMIT,
    token_estimator: "one-utf8-byte-per-input-token-upper-bound-v1",
    system_and_tool_token_reserve: REVIEW_SYSTEM_AND_TOOL_TOKEN_RESERVE,
    output_token_reserve: REVIEW_OUTPUT_TOKEN_RESERVE,
    serialized_payload_bytes: serializedPayloadBytes,
    conservative_input_tokens: conservativeInputTokens,
    conservative_total_tokens: conservativeInputTokens + REVIEW_OUTPUT_TOKEN_RESERVE,
  };
}

function withinCapacity(value) {
  return value.total_bytes <= REVIEW_SHARD_MAX_TOTAL_BYTES &&
    value.file_count <= REVIEW_SHARD_MAX_FILE_COUNT &&
    value.batch_count <= REVIEW_SHARD_MAX_BATCH_COUNT &&
    value.edge_count <= REVIEW_SHARD_MAX_EDGE_COUNT &&
    value.probe_count <= REVIEW_SHARD_MAX_PROBE_COUNT &&
    value.conservative_total_tokens <= REVIEW_SHARD_ADMISSION_TOKEN_LIMIT;
}

function semanticSelection(unit, role) {
  return {
    semantic_unit_id: unit.semantic_unit_id,
    path: unit.path,
    start_offset_bytes: unit.start_offset_bytes,
    end_offset_bytes: unit.end_offset_bytes,
    size_bytes: unit.size_bytes,
    sha256: unit.sha256,
    boundary_kind: unit.boundary_kind,
    transport_chunk_ids: unit.transport_chunk_ids,
    role,
  };
}

function semanticShardContent(semanticCatalog, emittedUnitIds, ownedUnitIds) {
  const owned = new Set(ownedUnitIds);
  const selections = sortedUnique(emittedUnitIds).map((unitId) => {
    const unit = semanticCatalog.unitsById.get(unitId);
    if (!unit) throw new Error(`INDEPENDENT_REVIEW_SEMANTIC_UNIT_NOT_FOUND:${unitId}`);
    return semanticSelection(unit, owned.has(unitId) ? "COVERAGE" : "CONTEXT");
  });
  return {
    content_selections: selections,
    owned_content_unit_ids: selections.filter((item) => item.role === "COVERAGE")
      .map((item) => item.semantic_unit_id),
    owned_transport_chunk_ids: selections.filter((item) => item.role === "COVERAGE")
      .flatMap((item) => item.transport_chunk_ids),
  };
}

function semanticPaths(semanticCatalog, unitIds) {
  return sortedUnique(unitIds.map((unitId) => {
    const unit = semanticCatalog.unitsById.get(unitId);
    if (!unit) throw new Error(`INDEPENDENT_REVIEW_SEMANTIC_UNIT_NOT_FOUND:${unitId}`);
    return unit.path;
  }));
}

function undirectedAdjacency(paths, edges) {
  const adjacency = new Map([...paths].map((path) => [path, []]));
  for (const edge of edges) {
    adjacency.get(edge.importer)?.push({ path: edge.dependency, edge });
    adjacency.get(edge.dependency)?.push({ path: edge.importer, edge });
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) =>
      left.path.localeCompare(right.path, "en") || edgeId(left.edge).localeCompare(edgeId(right.edge), "en"));
  }
  return adjacency;
}

function witnessTree(corePaths, reviewPaths, reviewEdges) {
  const adjacency = undirectedAdjacency(reviewPaths, reviewEdges);
  const parent = new Map();
  const root = new Map();
  const queue = [];
  for (const path of sortedUnique(corePaths)) {
    if (!adjacency.has(path)) adjacency.set(path, []);
    root.set(path, path);
    queue.push(path);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of adjacency.get(current) ?? []) {
      if (root.has(neighbor.path)) continue;
      root.set(neighbor.path, root.get(current));
      parent.set(neighbor.path, { prior: current, edge: neighbor.edge });
      queue.push(neighbor.path);
    }
  }
  return { parent, root };
}

function witnessFor(path, tree) {
  if (!tree.root.has(path)) throw new Error(`INDEPENDENT_REVIEW_WITNESS_UNREACHABLE:${path}`);
  const paths = new Set([path]);
  const edges = new Map();
  let current = path;
  while (tree.parent.has(current)) {
    const item = tree.parent.get(current);
    paths.add(item.prior);
    edges.set(edgeId(item.edge), item.edge);
    current = item.prior;
  }
  return { paths, edges };
}

async function partitionClaim({
  requirementId,
  scopeId,
  scopeKind,
  obligations,
  corePaths,
  reviewPaths,
  reviewEdges,
  identityByPath,
  contentByPath,
}) {
  const coreCapacity = await capacity(identityByPath, contentByPath, corePaths);
  if (!withinCapacity(coreCapacity)) {
    throw new Error(
      `INDEPENDENT_REVIEW_CLAIM_CORE_CAPACITY_EXCEEDED:${scopeId}:` +
      `bytes=${coreCapacity.total_bytes}:files=${coreCapacity.file_count}:batches=${coreCapacity.batch_count}`,
    );
  }
  const tree = witnessTree(corePaths, reviewPaths, reviewEdges);
  const edgeUnits = reviewEdges.map((edge) => {
    const left = witnessFor(edge.importer, tree);
    const right = witnessFor(edge.dependency, tree);
    return {
      id: edgeId(edge),
      paths: sortedUnique([...left.paths, ...right.paths]),
      edges: new Map([...left.edges, ...right.edges, [edgeId(edge), edge]]),
    };
  });
  const edgeVertices = new Set(edgeUnits.flatMap((unit) => unit.paths));
  const pathUnits = sortedUnique([...reviewPaths].filter((path) => !edgeVertices.has(path)))
    .map((path) => {
      const witness = witnessFor(path, tree);
      return { id: `path:${reviewSha256(path)}`, paths: sortedUnique(witness.paths), edges: witness.edges };
    });
  const units = [...edgeUnits, ...pathUnits].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const shards = [];
  let selectedPaths = new Set(corePaths);
  let selectedEdges = new Map();
  async function flush() {
    if (selectedEdges.size === 0 && selectedPaths.size === corePaths.length && shards.length > 0) return;
    const shardIndex = shards.length + 1;
    const paths = sortedUnique(selectedPaths);
    const shardCapacity = await capacity(
      identityByPath, contentByPath, paths, selectedEdges.size, 0,
    );
    if (!withinCapacity(shardCapacity)) {
      throw new Error(`INDEPENDENT_REVIEW_SHARD_CAPACITY_EXCEEDED:${scopeId}:S${shardIndex}`);
    }
    shards.push({
      requirement_id: requirementId,
      scope_kind: scopeKind,
      claim_id: scopeId,
      shard_id: `${scopeId}-S${String(shardIndex).padStart(2, "0")}`,
      core_paths: [...corePaths],
      paths,
      dependency_edges: [...selectedEdges.values()].sort((left, right) =>
        edgeId(left).localeCompare(edgeId(right), "en")).map((edge) => ({
        id: edgeId(edge),
        importer: edge.importer,
        dependency: edge.dependency,
      })),
      capacity: shardCapacity,
      probe_obligation_ids: [],
      probe_obligation_bindings: [],
    });
    selectedPaths = new Set(corePaths);
    selectedEdges = new Map();
  }
  if (units.length === 0) await flush();
  for (const unit of units) {
    const candidatePaths = new Set([...selectedPaths, ...unit.paths]);
    const candidateEdges = new Map([...selectedEdges, ...unit.edges]);
    const candidateCapacity = await capacity(
      identityByPath, contentByPath, candidatePaths, candidateEdges.size, 0,
    );
    if (!withinCapacity(candidateCapacity) &&
        (selectedPaths.size > corePaths.length || selectedEdges.size > 0)) {
      await flush();
    }
    for (const path of unit.paths) selectedPaths.add(path);
    for (const [id, edge] of unit.edges) selectedEdges.set(id, edge);
    const unitCapacity = await capacity(
      identityByPath, contentByPath, selectedPaths, selectedEdges.size, 0,
    );
    if (!withinCapacity(unitCapacity)) {
      throw new Error(`INDEPENDENT_REVIEW_EDGE_UNIT_CAPACITY_EXCEEDED:${scopeId}:${unit.id}`);
    }
  }
  if (selectedPaths.size > corePaths.length || selectedEdges.size > 0 || shards.length === 0) await flush();
  const obligationIds = sortedUnique((obligations ?? []).map((item) => item.obligation_id));
  for (const [index, obligationId] of obligationIds.entries()) {
    let target = shards[index];
    if (!target) {
      const shardIndex = shards.length + 1;
      const shardCapacity = await capacity(identityByPath, contentByPath, corePaths, 0, 1);
      target = {
        requirement_id: requirementId,
        scope_kind: scopeKind,
        claim_id: scopeId,
        shard_id: `${scopeId}-S${String(shardIndex).padStart(2, "0")}`,
        core_paths: [...corePaths],
        paths: [...corePaths],
        dependency_edges: [],
        capacity: shardCapacity,
        probe_obligation_ids: [],
        probe_obligation_bindings: [],
      };
      shards.push(target);
    }
    target.probe_obligation_ids = [obligationId];
    target.capacity = await capacity(
      identityByPath, contentByPath, target.paths, target.dependency_edges.length, 1,
    );
    if (!withinCapacity(target.capacity)) {
      throw new Error(`INDEPENDENT_REVIEW_PROBE_SHARD_CAPACITY_EXCEEDED:${target.shard_id}`);
    }
  }
  return shards;
}

async function partitionAtomicClaimSemantic({
  requirementId,
  claim,
  corePaths,
  implementationPaths,
  reviewEdges,
  identityByPath,
  semanticCatalog,
  coverageOwnedUnitIds,
  coverageOwnedEdgeIds,
}) {
  const shards = [];
  const anchorContextUnitIds = new Set();
  const obligationUnits = new Map();
  const obligationBindings = new Map();
  for (const obligation of claim.probe_obligations) {
    const target = semanticUnitForObligationAnchor(
      semanticCatalog,
      obligation.target_path,
      obligation.target_anchor,
      obligation.literal,
      `INDEPENDENT_REVIEW_OBLIGATION_TARGET:${obligation.obligation_id}`,
    );
    const targetUnit = target.unit;
    const testUnits = semanticCatalog.unitsByPath.get(obligation.mutation_test_path) ?? [];
    const selectorUnit = testUnits.find((unit) => (obligation.expected_failing_test_names ?? [])
      .some((name) => nonEmpty(name) && unit.bytes.toString("utf8").includes(name))) ??
      testUnits.find((unit) => (obligation.expected_failure_message_patterns ?? [])
        .some((pattern) => nonEmpty(pattern) && unit.bytes.toString("utf8").includes(pattern)));
    if (!selectorUnit) {
      throw new Error(`INDEPENDENT_REVIEW_OBLIGATION_TEST_SELECTOR_NOT_FOUND:${obligation.obligation_id}`);
    }
    anchorContextUnitIds.add(targetUnit.semantic_unit_id);
    obligationUnits.set(obligation.obligation_id,
      sortedUnique([targetUnit.semantic_unit_id, selectorUnit.semantic_unit_id]));
    obligationBindings.set(obligation.obligation_id, {
      obligation_id: obligation.obligation_id,
      ...target.binding,
    });
  }
  for (const path of implementationPaths) {
    const first = semanticCatalog.unitsByPath.get(path)?.[0];
    if (!first) throw new Error(`INDEPENDENT_REVIEW_SEMANTIC_PATH_EMPTY:${path}`);
    anchorContextUnitIds.add(first.semantic_unit_id);
  }

  async function appendShard({ emittedUnitIds, ownedUnitIds, edges = [], ownedEdgeIds = [], obligationIds = [] }) {
    const emitted = sortedUnique(emittedUnitIds);
    const owned = sortedUnique(ownedUnitIds);
    const shardNumber = shards.length + 1;
    const shardCapacity = await semanticCapacity(
      identityByPath, semanticCatalog, emitted, edges.length, obligationIds.length,
    );
    if (!withinCapacity(shardCapacity)) {
      const largest = emitted.map((unitId) => semanticCatalog.unitsById.get(unitId))
        .sort((left, right) => right.size_bytes - left.size_bytes)[0];
      throw new Error(
        `INDEPENDENT_REVIEW_ATOMIC_SEMANTIC_UNIT_CAPACITY_EXCEEDED:${claim.claim_id}:` +
        `${largest?.path ?? "unknown"}:${largest?.start_offset_bytes ?? -1}-${largest?.end_offset_bytes ?? -1}`,
      );
    }
    const content = semanticShardContent(semanticCatalog, emitted, owned);
    shards.push({
      requirement_id: requirementId,
      scope_kind: "ATOMIC_CLAIM",
      claim_id: claim.claim_id,
      shard_id: `${claim.claim_id}-S${String(shardNumber).padStart(2, "0")}`,
      core_paths: [...implementationPaths],
      paths: semanticPaths(semanticCatalog, emitted),
      dependency_edges: edges.map((edge) => ({ ...edge })),
      owned_dependency_edge_ids: sortedUnique(ownedEdgeIds),
      capacity: shardCapacity,
      probe_obligation_ids: obligationIds,
      probe_obligation_bindings: obligationIds.map((obligationId) => {
        const binding = obligationBindings.get(obligationId);
        if (!binding) {
          throw new Error(`INDEPENDENT_REVIEW_OBLIGATION_SEMANTIC_BINDING_MISSING:${obligationId}`);
        }
        return binding;
      }),
      ...content,
    });
    for (const unitId of owned) coverageOwnedUnitIds.add(unitId);
    for (const edgeIdentity of ownedEdgeIds) coverageOwnedEdgeIds.add(edgeIdentity);
  }

  for (const obligation of claim.probe_obligations) {
    const emitted = sortedUnique([
      ...anchorContextUnitIds,
      ...obligationUnits.get(obligation.obligation_id),
    ]);
    const owned = emitted.filter((unitId) => !coverageOwnedUnitIds.has(unitId));
    await appendShard({
      emittedUnitIds: emitted,
      ownedUnitIds: owned,
      obligationIds: [obligation.obligation_id],
    });
  }

  const claimAdjacency = new Map();
  for (const edge of reviewEdges) {
    for (const [from, to] of [[edge.importer, edge.dependency], [edge.dependency, edge.importer]]) {
      const neighbors = claimAdjacency.get(from) ?? [];
      neighbors.push({ path: to, edge });
      neighbors.sort((left, right) =>
        left.path.localeCompare(right.path, "en") || edgeId(left.edge).localeCompare(edgeId(right.edge), "en"));
      claimAdjacency.set(from, neighbors);
    }
  }
  const prior = new Map();
  const queue = [];
  for (const path of implementationPaths) {
    prior.set(path, null);
    queue.push(path);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of claimAdjacency.get(current) ?? []) {
      if (prior.has(neighbor.path)) continue;
      prior.set(neighbor.path, { path: current, edge: neighbor.edge });
      queue.push(neighbor.path);
    }
  }
  function connectedEdgeWitness(edge) {
    const result = new Map([[edgeId(edge), edge]]);
    let current = prior.has(edge.importer) ? edge.importer : edge.dependency;
    if (!prior.has(current)) {
      throw new Error(`INDEPENDENT_REVIEW_ATOMIC_EDGE_NOT_CONNECTED_TO_CORE:${claim.claim_id}:${edgeId(edge)}`);
    }
    while (prior.get(current) !== null) {
      const step = prior.get(current);
      result.set(edgeId(step.edge), step.edge);
      current = step.path;
    }
    return [...result.values()].sort((left, right) => edgeId(left).localeCompare(edgeId(right), "en"));
  }

  let selectedEdgeUnits = new Set();
  let selectedWitnessEdges = new Map();
  let selectedOwnedEdgeIds = new Set();
  async function flushEdgeWitnesses() {
    if (selectedWitnessEdges.size === 0) return;
    const emitted = sortedUnique([...anchorContextUnitIds, ...selectedEdgeUnits]);
    const owned = emitted.filter((unitId) => !coverageOwnedUnitIds.has(unitId));
    await appendShard({
      emittedUnitIds: emitted,
      ownedUnitIds: owned,
      edges: [...selectedWitnessEdges.values()].sort((left, right) =>
        edgeId(left).localeCompare(edgeId(right), "en")),
      ownedEdgeIds: sortedUnique([...selectedOwnedEdgeIds]),
    });
    selectedEdgeUnits = new Set();
    selectedWitnessEdges = new Map();
    selectedOwnedEdgeIds = new Set();
  }
  for (const edge of reviewEdges) {
    const witnessEdges = connectedEdgeWitness(edge);
    const edgeUnits = witnessEdges.flatMap((witness) => edgeSemanticUnitIds(semanticCatalog, witness));
    const candidateUnits = new Set([...selectedEdgeUnits, ...edgeUnits]);
    const candidateEdges = new Map(selectedWitnessEdges);
    for (const witness of witnessEdges) candidateEdges.set(edgeId(witness), witness);
    const candidateEmitted = sortedUnique([...anchorContextUnitIds, ...candidateUnits]);
    const candidateCapacity = await semanticCapacity(
      identityByPath, semanticCatalog, candidateEmitted, candidateEdges.size, 0,
    );
    if (!withinCapacity(candidateCapacity) && selectedWitnessEdges.size > 0) {
      await flushEdgeWitnesses();
    }
    for (const unitId of edgeUnits) selectedEdgeUnits.add(unitId);
    for (const witness of witnessEdges) selectedWitnessEdges.set(edgeId(witness), witness);
    const identity = edgeId(edge);
    if (!coverageOwnedEdgeIds.has(identity)) selectedOwnedEdgeIds.add(identity);
    const unitCapacity = await semanticCapacity(
      identityByPath,
      semanticCatalog,
      sortedUnique([...anchorContextUnitIds, ...selectedEdgeUnits]),
      selectedWitnessEdges.size,
      0,
    );
    if (!withinCapacity(unitCapacity)) {
      throw new Error(`INDEPENDENT_REVIEW_ATOMIC_EDGE_WITNESS_CAPACITY_EXCEEDED:${claim.claim_id}:${identity}`);
    }
  }
  await flushEdgeWitnesses();

  const remainingCoverageUnits = sortedUnique(corePaths.flatMap((path) =>
    (semanticCatalog.unitsByPath.get(path) ?? []).map((unit) => unit.semantic_unit_id)))
    .filter((unitId) => !coverageOwnedUnitIds.has(unitId));
  let selectedOwned = [];
  async function flushCoverage() {
    if (selectedOwned.length === 0) return;
    await appendShard({
      emittedUnitIds: sortedUnique([...anchorContextUnitIds, ...selectedOwned]),
      ownedUnitIds: selectedOwned,
    });
    selectedOwned = [];
  }
  for (const unitId of remainingCoverageUnits) {
    const candidateOwned = [...selectedOwned, unitId];
    const emitted = sortedUnique([...anchorContextUnitIds, ...candidateOwned]);
    const candidateCapacity = await semanticCapacity(identityByPath, semanticCatalog, emitted, 0, 0);
    if (!withinCapacity(candidateCapacity) && selectedOwned.length > 0) await flushCoverage();
    selectedOwned.push(unitId);
    const unitCapacity = await semanticCapacity(
      identityByPath,
      semanticCatalog,
      sortedUnique([...anchorContextUnitIds, ...selectedOwned]),
      0,
      0,
    );
    if (!withinCapacity(unitCapacity)) {
      const unit = semanticCatalog.unitsById.get(unitId);
      throw new Error(
        `INDEPENDENT_REVIEW_ATOMIC_SEMANTIC_UNIT_CAPACITY_EXCEEDED:${claim.claim_id}:` +
        `${unit.path}:${unit.start_offset_bytes}-${unit.end_offset_bytes}`,
      );
    }
  }
  await flushCoverage();
  if (shards.length === 0) {
    const emitted = [...anchorContextUnitIds];
    await appendShard({ emittedUnitIds: emitted, ownedUnitIds: [] });
  }
  return shards;
}

async function partitionDocumentGlobalCoverage({
  requirementId,
  reviewPaths,
  reviewEdges,
  identityByPath,
  semanticCatalog,
  coverageOwnedUnitIds,
}) {
  const shards = [];
  const scopeId = `${requirementId}-GLOBAL01`;
  let selectedUnitIds = new Set();
  let selectedOwnedUnitIds = new Set();
  let selectedEdges = [];

  async function flushEdges() {
    if (selectedEdges.length === 0) return;
    const shardNumber = shards.length + 1;
    const emitted = sortedUnique(selectedUnitIds);
    const owned = sortedUnique(selectedOwnedUnitIds);
    const shardCapacity = await semanticCapacity(
      identityByPath, semanticCatalog, emitted, selectedEdges.length, 0,
    );
    if (!withinCapacity(shardCapacity)) {
      throw new Error(`INDEPENDENT_REVIEW_DOCUMENT_GLOBAL_EDGE_CAPACITY_EXCEEDED:S${shardNumber}`);
    }
    const paths = semanticPaths(semanticCatalog, emitted);
    shards.push({
      requirement_id: requirementId,
      scope_kind: "DOCUMENT_GLOBAL_PERIPHERAL_COVERAGE",
      claim_id: scopeId,
      shard_id: `${scopeId}-S${String(shardNumber).padStart(3, "0")}`,
      core_paths: paths,
      paths,
      dependency_edges: selectedEdges.map((edge) => ({ ...edge })),
      owned_dependency_edge_ids: selectedEdges.map((edge) => edgeId(edge)).sort(),
      capacity: shardCapacity,
      probe_obligation_ids: [],
      probe_obligation_bindings: [],
      ...semanticShardContent(semanticCatalog, emitted, owned),
    });
    for (const unitId of owned) coverageOwnedUnitIds.add(unitId);
    selectedUnitIds = new Set();
    selectedOwnedUnitIds = new Set();
    selectedEdges = [];
  }

  for (const edge of reviewEdges) {
    const edgeUnitIds = edgeSemanticUnitIds(semanticCatalog, edge);
    const candidateUnits = new Set([...selectedUnitIds, ...edgeUnitIds]);
    const candidateEdges = [...selectedEdges, edge];
    const candidateCapacity = await semanticCapacity(
      identityByPath, semanticCatalog, [...candidateUnits], candidateEdges.length, 0,
    );
    if (!withinCapacity(candidateCapacity) && selectedEdges.length > 0) {
      await flushEdges();
    }
    for (const unitId of edgeUnitIds) {
      selectedUnitIds.add(unitId);
      if (!coverageOwnedUnitIds.has(unitId)) selectedOwnedUnitIds.add(unitId);
    }
    selectedEdges.push(edge);
    const unitCapacity = await semanticCapacity(
      identityByPath, semanticCatalog, [...selectedUnitIds], selectedEdges.length, 0,
    );
    if (!withinCapacity(unitCapacity)) {
      const units = edgeUnitIds.map((unitId) => semanticCatalog.unitsById.get(unitId));
      const largest = units.sort((left, right) => right.size_bytes - left.size_bytes)[0];
      throw new Error(
        `INDEPENDENT_REVIEW_DOCUMENT_GLOBAL_EDGE_SEMANTIC_UNIT_CAPACITY_EXCEEDED:${edgeId(edge)}:` +
        `${largest.path}:${largest.start_offset_bytes}-${largest.end_offset_bytes}`,
      );
    }
  }
  await flushEdges();

  let selectedCoverageUnits = [];
  async function flushPaths() {
    if (selectedCoverageUnits.length === 0) return;
    const shardNumber = shards.length + 1;
    const emitted = sortedUnique(selectedCoverageUnits);
    const paths = semanticPaths(semanticCatalog, emitted);
    const shardCapacity = await semanticCapacity(identityByPath, semanticCatalog, emitted, 0, 0);
    if (!withinCapacity(shardCapacity)) {
      throw new Error(`INDEPENDENT_REVIEW_DOCUMENT_GLOBAL_PATH_CAPACITY_EXCEEDED:S${shardNumber}`);
    }
    shards.push({
      requirement_id: requirementId,
      scope_kind: "DOCUMENT_GLOBAL_PERIPHERAL_COVERAGE",
      claim_id: scopeId,
      shard_id: `${scopeId}-S${String(shardNumber).padStart(3, "0")}`,
      core_paths: paths,
      paths,
      dependency_edges: [],
      owned_dependency_edge_ids: [],
      capacity: shardCapacity,
      probe_obligation_ids: [],
      probe_obligation_bindings: [],
      ...semanticShardContent(semanticCatalog, emitted, emitted),
    });
    for (const unitId of emitted) coverageOwnedUnitIds.add(unitId);
    selectedCoverageUnits = [];
  }
  const remainingUnitIds = sortedUnique(reviewPaths.flatMap((path) =>
    (semanticCatalog.unitsByPath.get(path) ?? []).map((unit) => unit.semantic_unit_id)))
    .filter((unitId) => !coverageOwnedUnitIds.has(unitId));
  for (const unitId of remainingUnitIds) {
    const candidateUnits = [...selectedCoverageUnits, unitId];
    const candidateCapacity = await semanticCapacity(
      identityByPath, semanticCatalog, candidateUnits, 0, 0,
    );
    if (!withinCapacity(candidateCapacity) && selectedCoverageUnits.length > 0) await flushPaths();
    selectedCoverageUnits.push(unitId);
    const unitCapacity = await semanticCapacity(
      identityByPath, semanticCatalog, selectedCoverageUnits, 0, 0,
    );
    if (!withinCapacity(unitCapacity)) {
      const unit = semanticCatalog.unitsById.get(unitId);
      throw new Error(
        `INDEPENDENT_REVIEW_DOCUMENT_GLOBAL_PATH_SEMANTIC_UNIT_CAPACITY_EXCEEDED:` +
        `${unit.path}:${unit.start_offset_bytes}-${unit.end_offset_bytes}`,
      );
    }
  }
  await flushPaths();
  return shards;
}

/** Captures the full document graph once, then assigns atomic slices and one
 * global peripheral plan. Requirement plans are projections of this frozen
 * document plan; they never independently rediscover or repeat the universe. */
export async function deriveIndependentReviewDocumentPlan({
  document,
  repoRoot,
  documentPath,
  sourceSnapshotContext,
  testOnlyMaxShardCount,
}) {
  const maxShardCount = testOnlyMaxShardCount === undefined
    ? REVIEW_PLAN_MAX_SHARD_COUNT
    : (process.env.NODE_ENV === "test" && Number.isSafeInteger(testOnlyMaxShardCount) &&
        testOnlyMaxShardCount > 0 && testOnlyMaxShardCount <= REVIEW_PLAN_MAX_SHARD_COUNT
      ? testOnlyMaxShardCount
      : (() => { throw new Error("INDEPENDENT_REVIEW_TEST_CAPACITY_POLICY_INVALID"); })());
  const requirements = [...(document.requirements ?? [])].sort((left, right) =>
    left.requirement_id.localeCompare(right.requirement_id, "en"));
  if (requirements.length === 0 || requirements.some((requirement) =>
    !isRecord(requirement) || !nonEmpty(requirement.requirement_id) ||
    !Array.isArray(requirement.control_claims) || requirement.control_claims.length === 0)) {
    throw new Error("INDEPENDENT_REVIEW_DOCUMENT_PLAN_REQUIREMENTS_INVALID");
  }
  const requirementIds = requirements.map((requirement) => requirement.requirement_id);
  if (new Set(requirementIds).size !== requirementIds.length) {
    throw new Error("INDEPENDENT_REVIEW_DOCUMENT_PLAN_REQUIREMENTS_DUPLICATE");
  }
  const capture = await captureIndependentReviewInputs({
    document,
    requirementIds,
    repoRoot,
    documentPath,
    sourceSnapshotContext,
  });
  const { reviewInputs, contentByPath, dependencyGraph: graph } = capture;
  const ts = await frozenTypescriptRuntime(repoRoot);
  const identityByPath = new Map(reviewInputs.files.map((file) => [file.path, file]));
  const universePaths = sortedUnique(reviewInputs.files.map((file) => file.path));
  const universeSet = new Set(universePaths);
  const semanticCatalog = buildSemanticUnitCatalog(ts, identityByPath, contentByPath);
  const coverageOwnedUnitIds = new Set();
  const coverageOwnedEdgeIds = new Set();
  const catalogPath = document.control_catalog?.path;
  const shardsByRequirement = new Map(requirementIds.map((requirementId) => [requirementId, []]));
  const obligationsByRequirement = new Map(requirementIds.map((requirementId) => [requirementId, []]));

  for (const requirement of requirements) {
    const claims = [...requirement.control_claims].sort((left, right) =>
      left.claim_id.localeCompare(right.claim_id, "en"));
    for (const claim of claims) {
      if (!isRecord(claim) || !nonEmpty(claim.claim_id) || !Array.isArray(claim.probe_obligations) ||
          claim.probe_obligations.length === 0) {
        throw new Error(`INDEPENDENT_REVIEW_PLAN_CLAIM_INVALID:${claim?.claim_id ?? "unknown"}`);
      }
      const citations = claimCitationPaths({ claim, repoRoot, documentPath });
      const implementationPaths = sortedUnique(claim.implementation_files.map((reference) =>
        containedRelative(repoRoot, repoRoot, reference,
          `INDEPENDENT_REVIEW_PLAN:${claim.claim_id}:implementation_files`)));
      const consumerPaths = sortedUnique([
        ...claim.positive_tests,
        ...claim.negative_or_mutation_tests,
      ].map((reference) => containedRelative(repoRoot, repoRoot, reference,
        `INDEPENDENT_REVIEW_PLAN:${claim.claim_id}:consumer_tests`)));
      const corePaths = sortedUnique([
        ...citations,
        ...(nonEmpty(catalogPath) && universeSet.has(catalogPath) ? [catalogPath] : []),
      ]);
      if (corePaths.some((path) => !universeSet.has(path))) {
        throw new Error(`INDEPENDENT_REVIEW_PLAN_CITATION_NOT_IN_UNIVERSE:${claim.claim_id}`);
      }
      const claimWitness = directedClaimWitness({
        graph,
        corePaths,
        implementationPaths,
        consumerPaths,
      });
      const componentPaths = new Set(claimWitness.paths);
      const componentEdges = claimWitness.edges;
      const atomicShards = await partitionAtomicClaimSemantic({
        requirementId: requirement.requirement_id,
        claim,
        corePaths: claimWitness.paths,
        implementationPaths,
        reviewEdges: componentEdges,
        identityByPath,
        semanticCatalog,
        coverageOwnedUnitIds,
        coverageOwnedEdgeIds,
      });
      shardsByRequirement.get(requirement.requirement_id).push(...atomicShards);
      obligationsByRequirement.get(requirement.requirement_id).push(...claim.probe_obligations.map((item) =>
        item.obligation_id));
    }
  }

  const globalRequirementId = requirementIds.includes("K-015") ? "K-015" : requirementIds[0];
  const peripheralEdges = graph.edges.filter((edge) => !coverageOwnedEdgeIds.has(edgeId(edge)));
  const globalShards = await partitionDocumentGlobalCoverage({
    requirementId: globalRequirementId,
    reviewPaths: universePaths,
    reviewEdges: peripheralEdges,
    identityByPath,
    semanticCatalog,
    coverageOwnedUnitIds,
  });
  shardsByRequirement.get(globalRequirementId).push(...globalShards);

  const allShards = requirementIds.flatMap((requirementId) => shardsByRequirement.get(requirementId));
  const expectedPaths = universePaths;
  const expectedEdges = sortedUnique(graph.edges.map(edgeId));
  const coveredPaths = sortedUnique(allShards.flatMap((shard) => shard.paths));
  const coveredEdges = sortedUnique(allShards.flatMap((shard) =>
    shard.dependency_edges.map((edge) => edge.id)));
  const ownedEdges = allShards.flatMap((shard) => shard.owned_dependency_edge_ids);
  if (stableReviewStringify(coveredPaths) !== stableReviewStringify(expectedPaths)) {
    throw new Error("INDEPENDENT_REVIEW_DOCUMENT_PLAN_PATH_COVERAGE_INCOMPLETE");
  }
  if (stableReviewStringify(coveredEdges) !== stableReviewStringify(expectedEdges) ||
      new Set(ownedEdges).size !== ownedEdges.length ||
      stableReviewStringify(sortedUnique(ownedEdges)) !== stableReviewStringify(expectedEdges)) {
    throw new Error("INDEPENDENT_REVIEW_DOCUMENT_PLAN_EDGE_COVERAGE_INCOMPLETE");
  }
  const expectedContentUnitIds = sortedUnique([...semanticCatalog.unitsById.keys()]);
  const ownedContentUnitIds = allShards.flatMap((shard) => shard.owned_content_unit_ids);
  if (new Set(ownedContentUnitIds).size !== ownedContentUnitIds.length ||
      stableReviewStringify(sortedUnique(ownedContentUnitIds)) !== stableReviewStringify(expectedContentUnitIds)) {
    throw new Error("INDEPENDENT_REVIEW_DOCUMENT_PLAN_CONTENT_UNIT_EXACT_UNION_INVALID");
  }
  const expectedTransportChunkIds = sortedUnique([...semanticCatalog.unitsById.values()].flatMap((unit) =>
    unit.transport_chunk_ids));
  const ownedTransportChunkIds = allShards.flatMap((shard) => shard.owned_transport_chunk_ids);
  if (new Set(ownedTransportChunkIds).size !== ownedTransportChunkIds.length ||
      stableReviewStringify(sortedUnique(ownedTransportChunkIds)) !==
        stableReviewStringify(expectedTransportChunkIds)) {
    throw new Error("INDEPENDENT_REVIEW_DOCUMENT_PLAN_TRANSPORT_CHUNK_EXACT_UNION_INVALID");
  }
  const totalDuplicatedBytes = allShards.reduce((sum, shard) => sum + shard.capacity.total_bytes, 0);
  if (!Number.isSafeInteger(allShards.length) || allShards.length < 1 ||
      allShards.length > maxShardCount ||
      totalDuplicatedBytes > REVIEW_PLAN_MAX_DUPLICATED_TOTAL_BYTES) {
    throw new Error(
      `INDEPENDENT_REVIEW_DOCUMENT_PLAN_TOTAL_CAPACITY_EXCEEDED:` +
      `shards=${allShards.length}:max_shards=${maxShardCount}:bytes=${totalDuplicatedBytes}`,
    );
  }
  const fullGraphSha256 = reviewSha256(stableReviewStringify({
    paths: expectedPaths,
    directed_edges: graph.edges,
  }));
  const semanticContentSha256 = reviewSha256(stableReviewStringify(
    [...semanticCatalog.unitsById.values()].map((unit) => ({
      semantic_unit_id: unit.semantic_unit_id,
      path: unit.path,
      start_offset_bytes: unit.start_offset_bytes,
      end_offset_bytes: unit.end_offset_bytes,
      size_bytes: unit.size_bytes,
      sha256: unit.sha256,
      boundary_kind: unit.boundary_kind,
      transport_chunk_ids: unit.transport_chunk_ids,
    })),
  ));
  const globalPeripheralIdentity = {
    owner_requirement_id: globalRequirementId,
    expected_paths: sortedUnique(globalShards.flatMap((shard) => shard.paths)),
    expected_dependency_edges: sortedUnique(globalShards.flatMap((shard) =>
      shard.dependency_edges.map((edge) => edge.id))),
    expected_owned_dependency_edge_ids: sortedUnique(globalShards.flatMap((shard) =>
      shard.owned_dependency_edge_ids)),
    expected_owned_content_unit_ids: sortedUnique(globalShards.flatMap((shard) =>
      shard.owned_content_unit_ids)),
    expected_owned_transport_chunk_ids: sortedUnique(globalShards.flatMap((shard) =>
      shard.owned_transport_chunk_ids)),
    shards: globalShards,
  };
  const globalPeripheralPlanSha256 = reviewSha256(stableReviewStringify(globalPeripheralIdentity));
  const documentIdentity = {
    schema_version: "1.0",
    algorithm: "document-wide-atomic-claims-plus-single-global-directed-edge-cover-v3",
    requirement_ids: requirementIds,
    review_inputs_sha256: reviewInputs.sha256,
    review_universe_sha256: reviewInputs.universe.sha256,
    source_snapshot_sha256: reviewInputs.worktree_state.source_snapshot_sha256,
    supplemental_inputs_sha256: reviewInputs.worktree_state.supplemental_inputs_sha256,
    full_graph_sha256: fullGraphSha256,
    global_peripheral_plan_sha256: globalPeripheralPlanSha256,
    global_peripheral_owner_requirement_id: globalRequirementId,
    expected_paths: expectedPaths,
    expected_dependency_edges: expectedEdges,
    expected_owned_dependency_edge_ids: expectedEdges,
    expected_content_unit_ids: expectedContentUnitIds,
    expected_transport_chunk_ids: expectedTransportChunkIds,
    semantic_content_sha256: semanticContentSha256,
    review_model: INDEPENDENT_REVIEW_MODEL,
    review_reasoning_effort: INDEPENDENT_REVIEW_REASONING_EFFORT,
    host_context_token_limit: INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT,
    review_shard_admission_token_limit: REVIEW_SHARD_ADMISSION_TOKEN_LIMIT,
    planned_review_turn_count: allShards.length,
    document_review_turn_budget_max: maxShardCount,
    total_duplicated_bytes: totalDuplicatedBytes,
    document_duplicated_bytes_budget_max: REVIEW_PLAN_MAX_DUPLICATED_TOTAL_BYTES,
    shard_assignments: requirementIds.map((requirementId) => ({
      requirement_id: requirementId,
      shard_ids: shardsByRequirement.get(requirementId).map((shard) => shard.shard_id),
    })),
  };
  const documentPlanSha256 = reviewSha256(stableReviewStringify(documentIdentity));
  const requirementPlans = new Map();
  for (const requirementId of requirementIds) {
    const shards = shardsByRequirement.get(requirementId);
    const expectedProbeObligations = sortedUnique(obligationsByRequirement.get(requirementId));
    const coveredProbeObligations = sortedUnique(shards.flatMap((shard) => shard.probe_obligation_ids));
    if (stableReviewStringify(coveredProbeObligations) !== stableReviewStringify(expectedProbeObligations)) {
      throw new Error(`INDEPENDENT_REVIEW_PLAN_PROBE_COVERAGE_INCOMPLETE:${requirementId}`);
    }
    const identity = {
      schema_version: "1.0",
      algorithm: "document-plan-requirement-projection-v3",
      requirement_id: requirementId,
      review_subject_sha256: independentReviewSubjectSha256(document, [requirementId]),
      review_inputs_sha256: reviewInputs.sha256,
      review_universe_sha256: reviewInputs.universe.sha256,
      source_snapshot_sha256: reviewInputs.worktree_state.source_snapshot_sha256,
      supplemental_inputs_sha256: reviewInputs.worktree_state.supplemental_inputs_sha256,
      document_plan_sha256: documentPlanSha256,
      graph_sha256: fullGraphSha256,
      full_graph_sha256: fullGraphSha256,
      global_peripheral_plan_sha256: globalPeripheralPlanSha256,
      global_peripheral_owner_requirement_id: globalRequirementId,
      includes_document_global_peripheral: requirementId === globalRequirementId,
      expected_paths: sortedUnique(shards.flatMap((shard) => shard.paths)),
      expected_dependency_edges: sortedUnique(shards.flatMap((shard) =>
        shard.dependency_edges.map((edge) => edge.id))),
      expected_owned_dependency_edge_ids: sortedUnique(shards.flatMap((shard) =>
        shard.owned_dependency_edge_ids)),
      expected_owned_content_unit_ids: sortedUnique(shards.flatMap((shard) =>
        shard.owned_content_unit_ids)),
      expected_owned_transport_chunk_ids: sortedUnique(shards.flatMap((shard) =>
        shard.owned_transport_chunk_ids)),
      expected_probe_obligations: expectedProbeObligations,
      total_duplicated_bytes: shards.reduce((sum, shard) => sum + shard.capacity.total_bytes, 0),
      review_model: INDEPENDENT_REVIEW_MODEL,
      review_reasoning_effort: INDEPENDENT_REVIEW_REASONING_EFFORT,
      host_context_token_limit: INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT,
      shards,
    };
    requirementPlans.set(requirementId, {
      ...identity,
      plan_sha256: reviewSha256(stableReviewStringify(identity)),
    });
  }
  const result = {
    ...documentIdentity,
    document_plan_sha256: documentPlanSha256,
    global_peripheral_plan: globalPeripheralIdentity,
    requirement_plans: requirementIds.map((requirementId) => requirementPlans.get(requirementId)),
  };
  Object.defineProperties(result, {
    requirementPlans: { value: requirementPlans, enumerable: false },
    reviewCapture: { value: capture, enumerable: false },
    semanticCatalog: { value: semanticCatalog, enumerable: false },
  });
  return result;
}

export async function deriveIndependentReviewPlan({
  document,
  requirementId,
  repoRoot,
  documentPath,
  sourceSnapshotContext,
  testOnlyMaxShardCount,
}) {
  const documentPlan = await deriveIndependentReviewDocumentPlan({
    document,
    repoRoot,
    documentPath,
    sourceSnapshotContext,
    testOnlyMaxShardCount,
  });
  const plan = documentPlan.requirementPlans.get(requirementId);
  if (!plan) throw new Error(`INDEPENDENT_REVIEW_PLAN_REQUIREMENT_INVALID:${requirementId}`);
  Object.defineProperty(plan, "documentPlan", { value: documentPlan, enumerable: false, configurable: true });
  return plan;
}

export async function createIndependentReviewShardReceipt({
  document,
  requirementId,
  claimId,
  shardId,
  repoRoot,
  documentPath,
  sourceFingerprint,
  nonce,
  sourceSnapshotContext,
}) {
  if (!/^[a-f0-9]{64}$/u.test(sourceFingerprint ?? "") || !/^[a-f0-9]{32}$/u.test(nonce ?? "")) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_RECEIPT_IDENTITY_INVALID");
  }
  const plan = await deriveIndependentReviewPlan({
    document,
    requirementId,
    repoRoot,
    documentPath,
    sourceSnapshotContext,
  });
  const shard = plan.shards.find((item) => item.claim_id === claimId && item.shard_id === shardId);
  if (!shard) throw new Error(`INDEPENDENT_REVIEW_SHARD_NOT_FOUND:${claimId}:${shardId}`);
  const claim = shard.scope_kind === "ATOMIC_CLAIM"
    ? claimFor(document, requirementId, claimId).claim
    : {
        claim_id: claimId,
        control: "Mechanically assigned release-critical peripheral paths and dependency edges are reviewed bottom-up.",
        probe_obligations: [],
      };
  const { reviewInputs, contentByPath } = plan.documentPlan.reviewCapture;
  const identityByPath = new Map(reviewInputs.files.map((file) => [file.path, file]));
  const files = await materializeSemanticUnitSelection(
    identityByPath,
    plan.documentPlan.semanticCatalog,
    shard.content_selections.map((selection) => selection.semantic_unit_id),
  );
  const batches = reviewContentBatches(files);
  const receipt = {
    schema_version: "4.0",
    receipt_kind: "INDEPENDENT_REVIEW_ATOMIC_CLAIM_SHARD_INPUT",
    nonce,
    source_fingerprint: sourceFingerprint,
    requirement_id: requirementId,
    scope_kind: shard.scope_kind,
    claim_id: claimId,
    shard_id: shardId,
    plan_sha256: plan.plan_sha256,
    review_subject_sha256: plan.review_subject_sha256,
    review_inputs_sha256: plan.review_inputs_sha256,
    review_universe_sha256: plan.review_universe_sha256,
    source_snapshot_sha256: plan.source_snapshot_sha256,
    supplemental_inputs_sha256: plan.supplemental_inputs_sha256,
    document_plan_sha256: plan.document_plan_sha256,
    graph_sha256: plan.graph_sha256,
    full_graph_sha256: plan.full_graph_sha256,
    global_peripheral_plan_sha256: plan.global_peripheral_plan_sha256,
    claim_sha256: reviewSha256(stableReviewStringify(claim)),
    core_paths: shard.core_paths,
    dependency_edges: shard.dependency_edges,
    owned_dependency_edge_ids: shard.owned_dependency_edge_ids,
    content_selections: shard.content_selections,
    owned_content_unit_ids: shard.owned_content_unit_ids,
      owned_transport_chunk_ids: shard.owned_transport_chunk_ids,
    probe_obligation_ids: shard.probe_obligation_ids,
    probe_obligation_bindings: shard.probe_obligation_bindings,
    content_policy: {
      overflow_policy: "EMIT_ALL_ORDERED_CHUNKS_WITHOUT_OMISSION",
      reviewer_shard_bytes_max: REVIEW_SHARD_MAX_TOTAL_BYTES,
      reviewer_shard_files_max: REVIEW_SHARD_MAX_FILE_COUNT,
      reviewer_shard_batches_max: REVIEW_SHARD_MAX_BATCH_COUNT,
    },
    content_total_bytes: shard.capacity.total_bytes,
    content_chunk_count: batches.length,
    files,
  };
  for (let index = 0; index < receipt.content_chunk_count; index += 1) {
    createIndependentReviewShardChunkReceipt(receipt, index);
  }
  return { receipt, batches, plan, shard };
}

export function createIndependentReviewShardChunkReceipt(receipt, chunkIndex) {
  if (!isRecord(receipt) || receipt.schema_version !== "4.0" ||
      receipt.receipt_kind !== "INDEPENDENT_REVIEW_ATOMIC_CLAIM_SHARD_INPUT" ||
      !Array.isArray(receipt.files) || !Number.isInteger(chunkIndex) || chunkIndex < 0 ||
      chunkIndex >= receipt.content_chunk_count) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_CHUNK_INVALID");
  }
  const batches = reviewContentBatches(receipt.files);
  const selectedBatch = batches[chunkIndex];
  if (!selectedBatch) throw new Error("INDEPENDENT_REVIEW_SHARD_CHUNK_MISSING");
  const output = {
    schema_version: "4.0",
    receipt_kind: "INDEPENDENT_REVIEW_ATOMIC_CLAIM_SHARD_BATCH_READ",
    nonce: receipt.nonce,
    source_fingerprint: receipt.source_fingerprint,
    requirement_id: receipt.requirement_id,
    scope_kind: receipt.scope_kind,
    claim_id: receipt.claim_id,
    shard_id: receipt.shard_id,
    plan_sha256: receipt.plan_sha256,
    review_subject_sha256: receipt.review_subject_sha256,
    review_inputs_sha256: receipt.review_inputs_sha256,
    review_universe_sha256: receipt.review_universe_sha256,
    source_snapshot_sha256: receipt.source_snapshot_sha256,
    supplemental_inputs_sha256: receipt.supplemental_inputs_sha256,
    document_plan_sha256: receipt.document_plan_sha256,
    graph_sha256: receipt.graph_sha256,
    full_graph_sha256: receipt.full_graph_sha256,
    global_peripheral_plan_sha256: receipt.global_peripheral_plan_sha256,
    claim_sha256: receipt.claim_sha256,
    core_paths: receipt.core_paths,
    dependency_edges: receipt.dependency_edges,
    owned_dependency_edge_ids: receipt.owned_dependency_edge_ids,
    content_selections: receipt.content_selections,
    owned_content_unit_ids: receipt.owned_content_unit_ids,
    owned_transport_chunk_ids: receipt.owned_transport_chunk_ids,
    probe_obligation_ids: receipt.probe_obligation_ids,
    probe_obligation_bindings: receipt.probe_obligation_bindings,
    content_policy: receipt.content_policy,
    content_total_bytes: receipt.content_total_bytes,
    content_chunk_count: receipt.content_chunk_count,
    global_chunk_index: chunkIndex,
    entries: selectedBatch,
  };
  const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (outputBytes > REVIEW_CONTENT_BATCH_OUTPUT_JSON_BYTES) {
    throw new Error(`INDEPENDENT_REVIEW_SHARD_BATCH_JSON_OVERFLOW:${chunkIndex}:${outputBytes}`);
  }
  return output;
}

function shellQuote(value) {
  const stringValue = String(value);
  if (/^[a-zA-Z0-9_./:=+-]+$/u.test(stringValue)) return stringValue;
  return `'${stringValue.replaceAll("'", `'"'"'`)}'`;
}

export function buildIndependentReviewShardInspectionCommand({
  traceabilityPath,
  nonce,
  requirementId,
  claimId,
  shardId,
  chunkIndex,
  liveContextPath,
}) {
  if (!nonEmpty(traceabilityPath) || !/^[a-f0-9]{32}$/u.test(nonce ?? "") ||
      !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_INSPECTION_COMMAND_INVALID");
  }
  const command = [
    process.execPath,
    "scripts/review/emit-review-shard-receipt.mjs",
    "--file", traceabilityPath,
    "--nonce", nonce,
    "--requirement", requirementId,
    "--claim", claimId,
    "--shard", shardId,
    "--chunk-index", String(chunkIndex),
  ];
  if (liveContextPath !== undefined) {
    if (!nonEmpty(liveContextPath) || !isAbsolute(liveContextPath)) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_LIVE_CONTEXT_PATH_INVALID");
    }
    command.push("--live-context", liveContextPath);
  }
  return command.map(shellQuote).join(" ");
}

export function buildIndependentReviewShardInspectionCommands({
  traceabilityPath,
  nonce,
  requirementId,
  claimId,
  shardId,
  chunkCount,
  liveContextPath,
}) {
  if (!Number.isInteger(chunkCount) || chunkCount < 1) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_INSPECTION_COMMAND_COUNT_INVALID");
  }
  return Array.from({ length: chunkCount }, (_, chunkIndex) =>
    buildIndependentReviewShardInspectionCommand({
      traceabilityPath,
      nonce,
      requirementId,
      claimId,
      shardId,
      chunkIndex,
      liveContextPath,
    }));
}
