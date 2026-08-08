import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/controller/", import.meta.url), { recursive: true });
await cp(
  new URL("../src/controller/", import.meta.url),
  new URL("../dist/controller/", import.meta.url),
  { recursive: true },
);
