import { z } from "zod/v4";

export const ORACLE_CASE_STATUSES = [
  "PASS",
  "FAIL",
  "BLOCKED_MODEL_PROVIDER",
  "BLOCKED_ENV",
  "BLOCKED_TEST_DATA",
  "UNSUPPORTED",
  "FLAKY",
  "NOT_RUN",
] as const;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const dateTimeSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "must be date-time");

const oracleResultSchema = z.object({
  oracle_id: z.string().regex(/^[a-z][a-z0-9._-]+$/u),
  strength: z.enum(["HARD", "SEMANTIC", "MANUAL"]),
  status: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]),
  observed: jsonValueSchema,
  evidence_refs: z.array(z.string().min(1)),
  message: z.string().optional(),
}).strict();

const writeReceiptSchema = z.object({
  request_id: z.string().min(8),
  provider_record_id: z.string().uuid(),
  provider_status: z.literal("DRAFT"),
  provider_write_count: z.literal(1),
  exact_readback_id: z.string().uuid(),
  idempotent_replay: z.boolean(),
  posting_request_id: z.string().optional(),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

const caseResultSchema = z.object({
  case_id: z.string().regex(/^[A-Z][A-Z0-9-]{4,63}$/u),
  persona_id: z.string().regex(/^[a-z][a-z0-9_]+$/u),
  repeat_index: z.number().int().min(1).optional(),
  baseline_expectation: z.enum(["PASS", "EXPECTED_RED"]),
  actual_status: z.enum(ORACLE_CASE_STATUSES),
  hard_gate_passed: z.boolean(),
  expected_red_observed: z.boolean(),
  oracle_results: z.array(oracleResultSchema).min(1),
  evidence_refs: z.array(z.string().min(1)).refine((items) => new Set(items).size === items.length),
  blocker_detail: z.string().optional(),
  write_receipt: writeReceiptSchema.optional(),
  notes: z.string().optional(),
}).strict().superRefine((value, context) => {
  const hardOraclesPassed = value.oracle_results
    .filter((result) => result.strength === "HARD")
    .every((result) => result.status === "PASS");
  if (value.hard_gate_passed !== hardOraclesPassed) {
    context.addIssue({ code: "custom", message: "hard_gate_passed must be derived from HARD oracle results" });
  }
  if (value.actual_status === "PASS" && (!value.hard_gate_passed || value.expected_red_observed)) {
    context.addIssue({ code: "custom", message: "PASS requires hard gates and cannot preserve an expected red" });
  }
  if (value.expected_red_observed && value.actual_status !== "FAIL") {
    context.addIssue({ code: "custom", message: "An observed expected red must remain FAIL" });
  }
  if (
    ["BLOCKED_MODEL_PROVIDER", "BLOCKED_ENV", "BLOCKED_TEST_DATA"].includes(value.actual_status) &&
    !value.blocker_detail
  ) {
    context.addIssue({ code: "custom", message: "Blocked cases require blocker_detail" });
  }
});

export const oracleRunSchema = z.object({
  schema_version: z.literal("1.0"),
  run_id: z.string().min(8),
  suite_id: z.string().regex(/^[a-z0-9][a-z0-9._-]+$/u),
  layer: z.enum(["DETERMINISTIC_CONTRACT", "AGENT2_BEHAVIOR", "FINAL_BROWSER_SIGNATURE"]),
  started_at: dateTimeSchema,
  finished_at: dateTimeSchema,
  environment: z.object({
    target: z.enum(["IN_MEMORY", "LOCAL_HTTP", "REMOTE_MCP", "AGENT2_API", "AGENT2_BROWSER"]),
    data_class: z.literal("SYNTHETIC_ONLY"),
    write_gate_start: z.enum(["CLOSED", "OPEN"]),
    write_gate_end: z.enum(["CLOSED", "OPEN"]),
    secrets_redacted: z.literal(true),
    mcp_server_version: z.string().optional(),
    agent_ids: z.array(z.string()).optional(),
    oauth_binding_fingerprint: z.string().optional(),
  }).strict(),
  case_results: z.array(caseResultSchema),
  summary: z.object({
    total: z.number().int().min(0),
    pass: z.number().int().min(0),
    fail: z.number().int().min(0),
    blocked_model_provider: z.number().int().min(0),
    blocked_env: z.number().int().min(0),
    blocked_test_data: z.number().int().min(0),
    unsupported: z.number().int().min(0),
    flaky: z.number().int().min(0),
    not_run: z.number().int().min(0),
  }).strict(),
  claim_guardrail_violations: z.array(z.string().regex(/^CG-[0-9]{3}$/u)),
}).strict().superRefine((value, context) => {
  const counted = value.summary.pass + value.summary.fail + value.summary.blocked_model_provider +
    value.summary.blocked_env + value.summary.blocked_test_data + value.summary.unsupported +
    value.summary.flaky + value.summary.not_run;
  if (value.summary.total !== value.case_results.length || counted !== value.summary.total) {
    context.addIssue({ code: "custom", message: "summary counts must equal case_results" });
  }
});

export type OracleRunResult = z.infer<typeof oracleRunSchema>;
export type OracleCaseResult = OracleRunResult["case_results"][number];
export type OracleResult = OracleCaseResult["oracle_results"][number];
