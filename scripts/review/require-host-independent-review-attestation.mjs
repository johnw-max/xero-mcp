#!/usr/bin/env node

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("Every host-review authority option must occur exactly once with one value");
    }
    values.set(name, value);
  }
  const expected = [
    "--gate-run-id", "--live-challenge-sha256", "--source-fingerprint",
    "--source-snapshot-manifest-sha256", "--approved-review-codex-sha256",
    "--approved-review-runtime-sha256",
  ];
  if (JSON.stringify([...values.keys()].sort()) !== JSON.stringify([...expected].sort()) ||
      !/^[0-9a-f-]{36}$/u.test(values.get("--gate-run-id") ?? "") ||
      expected.slice(1).some((name) => !/^[a-f0-9]{64}$/u.test(values.get(name) ?? ""))) {
    throw new Error("HOST_INDEPENDENT_REVIEW_ATTESTATION_INPUT_INVALID");
  }
  return Object.fromEntries(expected.map((name) => [name.slice(2).replaceAll("-", "_"), values.get(name)]));
}

const identity = parseArguments(process.argv.slice(2));
process.stderr.write(`${JSON.stringify({
  schema_version: "1.0",
  status: "LOCAL_EVIDENCE_UNTRUSTED",
  gate_l_claim: "NOT_IMPLIED",
  ...identity,
  reason: "A candidate-repository driver and verifier cannot authenticate their own reviewer process provenance.",
  required_authority: "An out-of-repository pinned parent driver must capture the immutable inputs, spawn the signed reviewer, verify the raw lifecycle, and sign a receipt with a host-held key. No such authority is available to this repo-local Gate.",
})}\n`);
process.exitCode = 78;
