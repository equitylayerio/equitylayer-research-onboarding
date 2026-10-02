import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("standalone package dependencies", () => {
  it("declares each package imported by its source files", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    const directory = new URL("./", import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, directory), "utf8");
      for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        const name = match[1];
        if (name.startsWith(".") || name.startsWith("node:")) continue;
        const dependency = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
        expect(declared[dependency], `${file} imports undeclared ${dependency}`).toBeTruthy();
      }
    }
  });
});
