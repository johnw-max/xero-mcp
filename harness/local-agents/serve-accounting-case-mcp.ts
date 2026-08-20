import { resolve } from "node:path";
import { startLocalAgentAccountingCaseMcp } from "../runners/run-p0-accounting-case.js";

const auditPath = process.env.LOCAL_AGENT_SERVER_AUDIT_PATH;
if (!auditPath) {
  throw new Error("LOCAL_AGENT_SERVER_AUDIT_PATH is required.");
}

await startLocalAgentAccountingCaseMcp({ auditPath: resolve(auditPath) });
