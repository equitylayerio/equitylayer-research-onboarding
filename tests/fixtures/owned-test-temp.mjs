import { mkdtempSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Give each test process its own temporary root. Never remove an older directory.
if (process.argv[1]?.endsWith(".test.mjs")) {
  const root = mkdtempSync(join(tmpdir(), "el-suite-owned-"));
  const initial = lstatSync(root);
  process.env.TMPDIR = root;
  process.once("exit", () => {
    try {
      const current = lstatSync(root);
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === initial.dev &&
          current.ino === initial.ino && current.uid === process.getuid()) rmSync(root, { recursive: true });
    } catch { /* Preserve an unverified directory. Cleanup must not change the test result. */ }
  });
}
