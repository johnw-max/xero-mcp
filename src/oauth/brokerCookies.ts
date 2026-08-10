export const MCP_OAUTH_FLOW_COOKIE = "__Host-zcloak_oauth_flow";

export function brokerFlowCookieOptions(ttlSeconds: number) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "lax" as const,
    path: "/" as const,
    maxAge: ttlSeconds * 1_000,
  };
}

export function clearBrokerFlowCookieOptions() {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "lax" as const,
    path: "/" as const,
  };
}

/** Rejects duplicate or malformed cookies instead of choosing an attacker-controlled first/last value. */
export function readExactCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const encodedValues: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) encodedValues.push(rawValue.join("="));
  }
  if (encodedValues.length !== 1) return undefined;
  try {
    const value = decodeURIComponent(encodedValues[0] as string);
    return value.length > 0 && value.length <= 256 ? value : undefined;
  } catch {
    return undefined;
  }
}
