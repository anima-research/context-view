import { resolve } from "node:path";

import { main, promote as release, type Options, type Spec } from "@astra/promote";

const spec: Spec = {
  component: "context-view",
  packageName: "context-view",
  source: resolve(import.meta.dir, ".."),
  commands: {},
  adoption:
    "Nothing to restart: workflow:context-view starts each run's context-view-run.ts afresh by its installed path, from a directory outside ~/.local/lib/context-view, and a run already going keeps the modules it loaded at its start.",
};

export const promote = (options?: Options) => release(spec, options);

if (import.meta.main) await main(spec.packageName, promote);
