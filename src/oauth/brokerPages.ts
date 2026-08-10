import {
  XERO_LOGO_DATA_URI,
  ZCLOAK_APP_ICON_DATA_URI,
} from "./brandAssets.js";

export interface SelectableXeroOrganisation {
  connectionId: string;
  tenantName: string;
  tenantId: string;
  tenantType?: string;
}

export interface SwitchableXeroOrganisation {
  connectionId: string;
  tenantId: string;
  tenantName: string;
  current: boolean;
}

interface ConnectionShellOptions {
  title: string;
  eyebrow: string;
  description: string;
  content: string;
  providerKey: string;
  providerName: string;
  providerLogoDataUri: string;
  footer?: string;
  status?: "ready" | "attention";
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

function readableExpiry(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function renderProviderMark(options: ConnectionShellOptions): string {
  return `<div class="provider-mark" aria-label="Request from ${escapeHtml(options.providerName)}">
    <img src="${options.providerLogoDataUri}" alt="${escapeHtml(options.providerName)}">
  </div>`;
}

function renderConnectionShell(options: ConnectionShellOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(options.title)}</title>
<style>
:root{--surface:#fff;--surface-soft:#f7f9f8;--ink:#17201d;--muted:#65716c;--line:#dfe6e2;--green:#236d5d;--green-dark:#165548;--green-soft:#eaf4f0;--amber:#8b560f;--amber-soft:#fff7e8;--shadow:0 18px 52px rgba(28,56,47,.11);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201d;background:#f3f6f4}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 0%,rgba(51,155,128,.12),transparent 27rem),linear-gradient(180deg,#f8faf9 0%,#f1f5f3 100%);color:var(--ink)}
.page{min-height:100vh;padding:42px 18px 34px}.product-brand{width:max-content;margin:0 auto 22px;display:flex;align-items:center;gap:10px;font-size:17px;font-weight:770;letter-spacing:-.02em}.product-brand img{width:42px;height:42px;border-radius:12px;box-shadow:0 8px 20px rgba(20,79,65,.18)}
.card{width:min(100%,540px);margin:0 auto;background:rgba(255,255,255,.97);border:1px solid rgba(211,222,216,.92);border-radius:22px;box-shadow:var(--shadow);overflow:hidden;backdrop-filter:blur(10px)}
.intro{padding:30px 32px 24px;text-align:center;border-bottom:1px solid var(--line)}.provider-mark{width:76px;height:76px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;border-radius:50%;box-shadow:0 12px 30px rgba(19,177,215,.2)}.provider-mark img{display:block;width:100%;height:100%;object-fit:contain}
.eyebrow{margin:0 0 8px;color:var(--green);font-size:11px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.intro h1{margin:0;font-size:30px;line-height:1.16;letter-spacing:-.032em}.description{max-width:410px;margin:11px auto 0;color:var(--muted);font-size:14px;line-height:1.55}
.main-content{padding:24px 32px 30px;min-width:0}.section-label{margin:0 0 10px;font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#52605b}
fieldset{min-width:0;margin:0;padding:0;border:0}legend{width:100%;padding:0;margin:0 0 12px;font-weight:760;font-size:15px}.organisation-list{display:grid;gap:10px}.organisation{position:relative;display:flex;align-items:center;gap:13px;min-height:64px;padding:13px 15px;border:1px solid var(--line);border-radius:14px;background:#fff;cursor:pointer;transition:border-color .16s,box-shadow .16s,background .16s}.organisation:hover{border-color:#92b9ad;background:#fbfdfc}.organisation:has(input:checked){border-color:var(--green);background:var(--green-soft);box-shadow:0 0 0 3px rgba(35,109,93,.1)}
.organisation input{width:18px;height:18px;margin:0;accent-color:var(--green);flex:0 0 auto}.organisation-copy{display:grid;gap:4px;min-width:0}.organisation strong{font-size:15px;overflow-wrap:anywhere}.current-pill{display:inline-flex;width:max-content;padding:3px 8px;border-radius:999px;background:#dbeee7;color:var(--green-dark);font-size:11px;font-weight:760}
.form-actions{margin-top:20px}.primary{width:100%;min-height:48px;padding:0 18px;border:0;border-radius:12px;background:var(--green);color:#fff;font:inherit;font-size:14px;font-weight:760;cursor:pointer;box-shadow:0 9px 22px rgba(35,109,93,.2);transition:background .16s,transform .16s}.primary:hover{background:var(--green-dark);transform:translateY(-1px)}.primary:focus-visible,.organisation:focus-within{outline:3px solid rgba(44,130,107,.28);outline-offset:2px}
.notice{margin:0 0 18px;padding:10px 12px;border:1px solid #efd29d;border-radius:11px;background:var(--amber-soft);color:var(--amber);font-size:12px;line-height:1.45}.scope-card{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}.scope-list{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}.scope-list li{padding:7px 10px;border-radius:999px;background:var(--surface-soft);color:#45534e;font-size:12px;font-weight:650}.summary{display:grid;gap:4px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--surface-soft);text-align:center}.summary-row{display:grid;gap:4px}.summary-row span{color:var(--muted);font-size:12px}.summary-row strong{font-size:17px;overflow-wrap:anywhere}.current-summary{margin:0 0 14px;color:var(--muted);font-size:13px}.current-summary strong{color:var(--ink)}.success-banner{width:max-content;margin:0 auto 16px;padding:7px 10px;border-radius:999px;background:var(--green-soft);color:var(--green);font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
.footnote{width:min(100%,540px);margin:16px auto 0;text-align:center;color:#728079;font-size:11px;line-height:1.45}.footnote strong{color:#4f5e58}.inline-note{margin:14px 0 0;color:var(--muted);font-size:12px;line-height:1.5;text-align:center}.inline-note time{color:#45534e;font-weight:650}
@media(max-width:700px){.page{padding:24px 12px 26px}.product-brand{margin-bottom:18px}.card{border-radius:20px}.intro{padding:24px 20px 20px}.provider-mark{width:70px;height:70px;margin-bottom:15px}.intro h1{font-size:25px}.description{font-size:13px}.main-content{padding:20px}.organisation{min-height:58px;padding:11px 13px}.scope-card{margin-top:18px;padding-top:16px}.footnote{margin-top:13px}}
@media(max-width:390px){.page{padding-left:10px;padding-right:10px}.product-brand img{width:38px;height:38px}.product-brand{font-size:16px}.intro{padding-left:18px;padding-right:18px}.main-content{padding-left:18px;padding-right:18px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><div class="page">
  <header class="product-brand"><img src="${ZCLOAK_APP_ICON_DATA_URI}" alt=""><span>zCloak AI</span></header>
  <main class="card" data-connection-page="${escapeHtml(options.providerKey)}" data-page-status="${options.status ?? "ready"}">
    <section class="intro">${renderProviderMark(options)}<p class="eyebrow">${escapeHtml(options.eyebrow)}</p><h1>${escapeHtml(options.title)}</h1><p class="description">${escapeHtml(options.description)}</p></section>
    <section class="main-content">${options.content}</section>
  </main>
  <footer class="footnote">${options.footer ?? `<strong>Secure connection by zCloak AI</strong> · ${escapeHtml(options.providerName)} remains your system of record.`}</footer>
</div></body></html>`;
}

function renderScopeList(scopes: readonly string[]): string {
  const content = scopes.map((scope) => {
    if (scope === "xero.read") {
      return "<li>View accounting data</li>";
    }
    if (scope === "xero.draft.write") {
      return "<li>Prepare drafts</li>";
    }
    return `<li>${escapeHtml(scope)}</li>`;
  }).join("");
  return `<section class="scope-card"><p class="section-label">Access requested</p><ul class="scope-list">${content}</ul></section>`;
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
  return renderConnectionShell({
    title: "Connection ready",
    eyebrow: "Xero connection",
    description: `Xero is ready for ${options.hostName}.`,
    content: `<div class="success-banner">Connection confirmed</div>
      <div class="summary"><div class="summary-row"><span>Selected organisation</span><strong>${organisationName}</strong></div></div>
      <form method="get" action="${action}">${hiddenFields}<div class="form-actions"><button id="return-to-host" class="primary" type="submit">Return to ${hostName}</button></div></form>
      <p class="inline-note">This one-time response expires soon. Do not share this page.</p>`,
    providerKey: "xero",
    providerName: "Xero",
    providerLogoDataUri: XERO_LOGO_DATA_URI,
  });
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
      <span class="organisation-copy"><strong>${escapeHtml(organisation.tenantName)}</strong></span>
    </label>`).join("");
  const pocNotice = options.personalPocOnly
    ? `<div class="notice" role="status">Test connection · Intended for one user.</div>`
    : "";
  return renderConnectionShell({
    title: "Choose an organisation",
    eyebrow: "Requested by Xero",
    description: "Select the Xero organisation this Agent should use.",
    content: `${pocNotice}<form method="post" action="/oauth/xero/select">
      <input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}">
      <fieldset><legend>Available organisations</legend><div class="organisation-list">${choices}</div></fieldset>
      ${renderScopeList(options.requestedScopes)}
      <div class="form-actions"><button class="primary" type="submit">Continue</button></div>
    </form><p class="inline-note">You can switch organisations later from the conversation.</p>`,
    providerKey: "xero",
    providerName: "Xero",
    providerLogoDataUri: XERO_LOGO_DATA_URI,
    status: options.personalPocOnly ? "attention" : "ready",
  });
}

export function renderOrganisationSwitchPage(options: {
  ticket: string;
  csrfToken: string;
  currentOrganisation: SwitchableXeroOrganisation;
  organisations: readonly SwitchableXeroOrganisation[];
  expiresAt: Date;
}): string {
  if (options.organisations.length === 0 || !Number.isFinite(options.expiresAt.getTime())) {
    throw new Error("A valid organisation switch page requires at least one organisation and expiry.");
  }
  const choices = options.organisations.map((organisation) => `
    <label class="organisation">
      <input type="radio" name="connection_id" value="${escapeHtml(organisation.connectionId)}" required>
      <span class="organisation-copy"><strong>${escapeHtml(organisation.tenantName)}</strong>${organisation.current ? '<span class="current-pill">Currently connected</span>' : ""}</span>
    </label>`).join("");
  return renderConnectionShell({
    title: "Switch organisation",
    eyebrow: "Xero connection",
    description: "Choose which Xero organisation the Agent should use next.",
    content: `<p class="current-summary">Current: <strong>${escapeHtml(options.currentOrganisation.tenantName)}</strong></p><form method="post" action="/xero/organisation-switch">
      <input type="hidden" name="ticket" value="${escapeHtml(options.ticket)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(options.csrfToken)}">
      <fieldset><legend>Available organisations</legend><div class="organisation-list">${choices}</div></fieldset>
      <div class="form-actions"><button class="primary" type="submit">Switch organisation</button></div>
    </form><p class="inline-note">This link expires <time datetime="${escapeHtml(options.expiresAt.toISOString())}">${escapeHtml(readableExpiry(options.expiresAt))}</time>.</p>`,
    providerKey: "xero",
    providerName: "Xero",
    providerLogoDataUri: XERO_LOGO_DATA_URI,
  });
}

export function renderOrganisationSwitchResultPage(options: {
  status: "SWITCHED" | "UNCHANGED";
  tenantName: string;
}): string {
  const lead = options.status === "SWITCHED"
    ? "Organisation updated"
    : "Organisation unchanged";
  return renderConnectionShell({
    title: lead,
    eyebrow: "Xero connection",
    description: "Return to the Agent to continue.",
    content: `<div class="success-banner">Confirmed</div><div class="summary"><div class="summary-row"><span>Current organisation</span><strong>${escapeHtml(options.tenantName)}</strong></div></div>`,
    providerKey: "xero",
    providerName: "Xero",
    providerLogoDataUri: XERO_LOGO_DATA_URI,
  });
}
