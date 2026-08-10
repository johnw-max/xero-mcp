export interface SelectableXeroOrganisation {
  connectionId: string;
  tenantName: string;
  tenantId: string;
  tenantType?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function organisationHint(organisation: SelectableXeroOrganisation): string {
  const suffix = organisation.tenantId.length > 8
    ? organisation.tenantId.slice(-8)
    : organisation.tenantId;
  return [organisation.tenantType, `ID …${suffix}`].filter(Boolean).join(" · ");
}

function exactHttpsReturnUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Host return URL must be an absolute HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    /[;,]/u.test(parsed.pathname)
  ) {
    throw new Error("The Host return URL must be HTTPS without credentials, a fragment, or CSP-unsafe path characters.");
  }
  if (
    [...parsed.searchParams].length !== 2 ||
    parsed.searchParams.getAll("code").length !== 1 ||
    !parsed.searchParams.get("code") ||
    parsed.searchParams.getAll("state").length !== 1 ||
    !parsed.searchParams.get("state")
  ) {
    throw new Error("The Host return URL must contain one authorization code and state.");
  }
  return parsed;
}

export function personalPocHostReturnAction(returnUrl: string): string {
  const parsed = exactHttpsReturnUrl(returnUrl);
  return `${parsed.origin}${parsed.pathname}`;
}

/** A manual, user-activated handoff used only by the Personal POC browser flow. */
export function renderPersonalPocHostReturnPage(options: {
  returnUrl: string;
  hostName: string;
  organisationName: string;
}): string {
  const returnUrl = exactHttpsReturnUrl(options.returnUrl);
  const action = escapeHtml(`${returnUrl.origin}${returnUrl.pathname}`);
  const hiddenFields = [...returnUrl.searchParams].map(([name, value]) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
  ).join("");
  const hostName = escapeHtml(options.hostName);
  const organisationName = escapeHtml(options.organisationName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xero connection ready</title>
<style>body{font-family:system-ui,sans-serif;max-width:620px;margin:64px auto;padding:0 20px;color:#17202a}main{display:grid;gap:18px}.return{display:inline-block;width:max-content;background:#0b5cff;color:#fff;text-decoration:none;border:0;border-radius:8px;padding:12px 18px;font-weight:650;cursor:pointer}.notice{color:#52606d;font-size:.92rem}</style>
</head><body><main>
<h1>Xero connection ready</h1>
<p>Selected Xero organisation: <strong>${organisationName}</strong>.</p>
<p>Return to ${hostName} to finish enabling the accounting tools. The Agent must read the connection status and confirm this same organisation before any accounting work.</p>
<form method="get" action="${action}">${hiddenFields}<button id="return-to-host" class="return" type="submit">Return to ${hostName}</button></form>
<p class="notice">This is a short-lived, one-time authorization response. Do not share this page.</p>
</main></body></html>`;
}

export function renderXeroOrganisationSelectionPage(options: {
  organisations: readonly SelectableXeroOrganisation[];
  csrfToken: string;
  requestedScopes: readonly string[];
  personalPocOnly: boolean;
}): string {
  if (options.organisations.length === 0) {
    throw new Error("At least one Xero organisation is required for selection.");
  }
  const choices = options.organisations.map((organisation) => `
    <label class="organisation">
      <input type="radio" name="connection_id" value="${escapeHtml(organisation.connectionId)}" required>
      <span><strong>${escapeHtml(organisation.tenantName)}</strong><small>${escapeHtml(organisationHint(organisation))}</small></span>
    </label>`).join("");
  const pocNotice = options.personalPocOnly
    ? `<p class="warning" role="status"><strong>PERSONAL POC — HOST IDENTITY UNVERIFIED</strong><br>This connection is for one test user and must not be treated as team or workspace isolation.</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Choose a Xero organisation</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#17202a}main{display:grid;gap:18px}.organisation{display:flex;gap:12px;border:1px solid #c8d2dc;border-radius:10px;padding:16px;cursor:pointer}.organisation span{display:grid;gap:4px}.organisation small{color:#52606d}.warning{background:#fff4d6;border:1px solid #e3ad35;border-radius:8px;padding:12px}button{background:#0b5cff;color:white;border:0;border-radius:8px;padding:12px 18px;font-weight:650}code{font-size:.9em}</style>
</head><body><main>
<h1>Choose the Xero organisation for this Agent</h1>
<p>Select exactly one ledger for this MCP connection. This choice is never taken from chat text or an uploaded file.</p>
<p>To use another organisation later, revoke this MCP authorisation and connect again through Xero OAuth. A technical reconnect or page refresh does not change the ledger.</p>
${pocNotice}
<form method="post" action="/oauth/xero/select">
  <input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}">
  <fieldset><legend>Xero organisations</legend>${choices}</fieldset>
  <p>Requested Agent access: <code>${escapeHtml(options.requestedScopes.join(" "))}</code></p>
  <button type="submit">Connect selected organisation</button>
</form>
</main></body></html>`;
}
