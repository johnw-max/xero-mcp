import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/oauth/assets/", import.meta.url), { recursive: true });
await cp(
  new URL("../src/oauth/assets/", import.meta.url),
  new URL("../dist/oauth/assets/", import.meta.url),
  { recursive: true },
);
