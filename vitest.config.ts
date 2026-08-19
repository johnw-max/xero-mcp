import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fifteen tests in this suite do real work - hashing trees, resolving
    // dependency graphs, holding PostgreSQL advisory locks behind pg_sleep
    // barriers - and the 5s default is shorter than their honest running time.
    // The suite's failure count moved with machine load as a result, which made
    // real defects indistinguishable from clocks. One deadlock-ordering test was
    // measured at 5749ms and passed anyway, because Node timers are a minimum
    // delay rather than a deadline: under load the timeout slips exactly as much
    // as the test does. A generous ceiling is honest; a hung test still fails.
    testTimeout: 15_000,
    hookTimeout: 15_000,

    // The PostgreSQL integration files share one database. Run in parallel they
    // interfere - a readiness assertion sees another file's migration state, a
    // frozen-bytes check sees a write that has not settled - and roughly two
    // thirds of the failures a plain `npm test` reported were this, not defects.
    // package.json's own test:postgres:required already passes --maxWorkers=1;
    // the default path did not inherit it, so the command everyone actually runs
    // was the unreliable one. Serialising costs nothing here: the same suite
    // measured 519s in parallel against 251s serial, because the contention was
    // more expensive than the concurrency.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
