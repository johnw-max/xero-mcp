const value = process.env.TEST_DATABASE_URL;

let valid = false;
let unsafe = false;
if (value) {
  try {
    const parsed = new URL(value);
    const isPostgres = parsed.protocol === "postgresql:" || parsed.protocol === "postgres:";
    if (isPostgres) {
      const databaseName = decodeURIComponent(parsed.pathname.slice(1));
      valid = /^xero_mcp_test(?:_[a-z0-9][a-z0-9_]*)?$/.test(databaseName);
      unsafe = !valid;
    }
  } catch {
    valid = false;
  }
}

if (!valid) {
  console.error(JSON.stringify({
    status: "blocked",
    error: unsafe ? "TEST_DATABASE_URL_UNSAFE" : "TEST_DATABASE_URL_REQUIRED",
    message: unsafe
      ? "Refusing to run PostgreSQL integration tests against a non-test database; use xero_mcp_test or an xero_mcp_test_* database."
      : "Set a disposable PostgreSQL TEST_DATABASE_URL; conditional skips are not a release pass.",
  }));
  process.exitCode = 2;
}
