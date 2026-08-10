/**
 * One release identifier for every public Xero MCP surface.
 *
 * Keep this equal to package.json. The version contract test fails if the
 * package is bumped without updating this value, so initialize, health and
 * readiness cannot silently identify different builds.
 */
export const XERO_RELEASE_VERSION = "0.3.1";
