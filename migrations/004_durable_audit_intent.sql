ALTER TABLE tool_audit_logs
  DROP CONSTRAINT IF EXISTS tool_audit_logs_result_status_check;

ALTER TABLE tool_audit_logs
  ALTER COLUMN finished_at DROP NOT NULL;

ALTER TABLE tool_audit_logs
  ADD CONSTRAINT tool_audit_logs_result_status_check
  CHECK (result_status IN ('IN_PROGRESS', 'SUCCEEDED', 'REJECTED', 'FAILED'));

ALTER TABLE tool_audit_logs
  ADD CONSTRAINT tool_audit_logs_completion_shape_check
  CHECK (
    (result_status = 'IN_PROGRESS' AND finished_at IS NULL)
    OR
    (result_status <> 'IN_PROGRESS' AND finished_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS tool_audit_logs_in_progress_idx
  ON tool_audit_logs (started_at)
  WHERE result_status = 'IN_PROGRESS';
