import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** `contract/` sits beside `src/` in the repo and beside `dist/` in the built image, so one `..` works for both. */
const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contract");

export interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

export function loadBridgeOpenApi(): OpenApiDoc {
  return parse(readFileSync(join(CONTRACT_DIR, "bridge.openapi.yaml"), "utf8")) as OpenApiDoc;
}

export class ContractValidator {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction>();
  readonly doc: OpenApiDoc;

  constructor(doc: OpenApiDoc = loadBridgeOpenApi()) {
    this.doc = doc;
    this.ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
    addFormats.default ? addFormats.default(this.ajv) : (addFormats as unknown as (a: Ajv2020) => void)(this.ajv);
    this.ajv.addSchema({ $id: "openapi", components: doc.components }, "openapi");
  }

  schema(name: string): ValidateFunction {
    let v = this.cache.get(name);
    if (!v) {
      v = this.ajv.compile({ $ref: `openapi#/components/schemas/${name}` });
      this.cache.set(name, v);
    }
    return v;
  }

  validate(name: string, data: unknown): { ok: true } | { ok: false; errors: string } {
    const v = this.schema(name);
    if (v(data)) return { ok: true };
    return { ok: false, errors: this.ajv.errorsText(v.errors, { dataVar: name }) };
  }

  assert(name: string, data: unknown): void {
    const r = this.validate(name, data);
    if (!r.ok) throw new Error(`contract violation: ${r.errors}`);
  }
}
