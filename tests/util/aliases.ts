// Teaches Node's CommonJS resolver the same "@/*" -> "src/merge/*" mapping
// tsconfig.app.json declares for the ported merge pages, so a test can
// `require()` a real component that imports its siblings via that alias
// (e.g. InfoTip -> "@/components/ui/tooltip" -> "@/lib/utils").
//
// Deliberately hand-rolled rather than pulling in `tsconfig-paths`: this repo
// keeps its dependency surface minimal on purpose (see the same reasoning in
// DEC-0068's hand-rolled JWT signing), and the mapping is a single line of
// real logic. Import this for side effects BEFORE importing any aliased
// module:  import "./util/aliases";
import * as path from "path";
import { createRequire } from "module";

type ResolveFilename = (request: string, ...rest: unknown[]) => string;

const Module = createRequire(__filename)("module") as {
  _resolveFilename: ResolveFilename;
};

const MERGE_ROOT = path.resolve(__dirname, "..", "..", "src", "merge");
const original = Module._resolveFilename;

Module._resolveFilename = function (request: string, ...rest: unknown[]): string {
  const mapped = request.startsWith("@/") ? path.join(MERGE_ROOT, request.slice(2)) : request;
  return original.call(this, mapped, ...rest);
} as ResolveFilename;
