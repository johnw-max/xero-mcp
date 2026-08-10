import { describe, expect, it } from "vitest";
import {
  brokerFlowCookieOptions,
  clearBrokerFlowCookieOptions,
  MCP_OAUTH_FLOW_COOKIE,
  readExactCookie,
} from "../src/oauth/brokerCookies.js";

describe("OAuth Broker flow cookie", () => {
  it("uses the __Host boundary and browser-flow TTL", () => {
    expect(MCP_OAUTH_FLOW_COOKIE).toBe("__Host-zcloak_oauth_flow");
    expect(brokerFlowCookieOptions(600)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600_000,
    });
    expect(clearBrokerFlowCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("reads one exact encoded cookie", () => {
    expect(readExactCookie("other=1; __Host-zcloak_oauth_flow=abc%2F123", MCP_OAUTH_FLOW_COOKIE))
      .toBe("abc/123");
  });

  it.each([
    ["duplicate", "__Host-zcloak_oauth_flow=one; __Host-zcloak_oauth_flow=two"],
    ["malformed encoding", "__Host-zcloak_oauth_flow=%E0%A4%A"],
    ["empty", "__Host-zcloak_oauth_flow="],
    ["oversized", `__Host-zcloak_oauth_flow=${"a".repeat(257)}`],
  ])("rejects a %s cookie", (_label, header) => {
    expect(readExactCookie(header, MCP_OAUTH_FLOW_COOKIE)).toBeUndefined();
  });
});
