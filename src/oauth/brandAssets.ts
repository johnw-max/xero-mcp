import { readFileSync } from "node:fs";

function pngDataUri(relativePath: string): string {
  const bytes = readFileSync(new URL(relativePath, import.meta.url));
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

/** Real brand assets sourced from the current Work product and Xero media library. */
export const ZCLOAK_APP_ICON_DATA_URI = pngDataUri("./assets/zcloak-app-icon.png");
export const XERO_LOGO_DATA_URI = pngDataUri("./assets/xero-logo.png");
