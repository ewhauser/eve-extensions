import { describe, expect, it } from "vitest";

import { createDeterministicZip } from "./deterministic-zip.js";

describe("createDeterministicZip", () => {
  it("is stable regardless of input ordering", () => {
    const first = createDeterministicZip([
      { content: Buffer.from("two"), path: "b.txt" },
      { content: Buffer.from("one"), path: "a.txt" },
    ]);
    const second = createDeterministicZip([
      { content: Buffer.from("one"), path: "a.txt" },
      { content: Buffer.from("two"), path: "b.txt" },
    ]);

    expect(first).toEqual(second);
    expect(first.readUInt32LE(0)).toBe(0x04034b50);
    expect(first.readUInt32LE(first.byteLength - 22)).toBe(0x06054b50);
  });

  it("rejects traversal paths", () => {
    expect(() => createDeterministicZip([{ content: Buffer.alloc(0), path: "../secret" }])).toThrow(
      /Invalid ZIP entry path/,
    );
  });
});
