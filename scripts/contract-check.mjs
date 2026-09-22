// Fails when src/contract.ts is not what contract/bridge.openapi.yaml currently generates.
//
// The generated types are checked in so that `pnpm install && pnpm build` needs no code generation. The
// price of checking a generated file in is that it can silently fall behind its source, so this runs in
// `pnpm test`: edit the spec, forget `pnpm contract:generate`, and the build goes red instead of the types
// quietly describing an API the service no longer serves.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = join(root, "contract", "bridge.openapi.yaml");
const checkedIn = join(root, "src", "contract.ts");

const tmp = mkdtempSync(join(tmpdir(), "contract-check-"));
try {
  const fresh = join(tmp, "contract.ts");
  execFileSync("pnpm", ["exec", "openapi-typescript", spec, "-o", fresh], { cwd: root, stdio: "pipe" });
  if (readFileSync(fresh, "utf8") !== readFileSync(checkedIn, "utf8")) {
    console.error(
      "src/contract.ts is out of date with contract/bridge.openapi.yaml.\n" +
        "Run `pnpm contract:generate` and commit the result.",
    );
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
