const xeroIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shortCodePattern = /^[A-Za-z0-9!_-]{1,64}$/;

export function xeroBillDeepLink(shortCode: string | undefined, invoiceId: string | undefined): string | undefined {
  if (!shortCode || !invoiceId || !shortCodePattern.test(shortCode) || !xeroIdPattern.test(invoiceId)) {
    return undefined;
  }
  const url = new URL("https://go.xero.com/organisationlogin/default.aspx");
  url.searchParams.set("shortcode", shortCode);
  url.searchParams.set("redirecturl", `/AccountsPayable/Edit.aspx?InvoiceID=${invoiceId}`);
  return url.toString();
}

export function safeXeroTenantShortCode(value: unknown): string | undefined {
  return typeof value === "string" && shortCodePattern.test(value) ? value : undefined;
}
