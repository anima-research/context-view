import { resolve } from "node:path";

import { main, promote as release, type Options, type Spec } from "@astra/promote";

const spec: Spec = {
  component: "context-view",
  packageName: "context-view",
  source: resolve(import.meta.dir, ".."),
  commands: {},
  prepare: async ({ stage, run }) => {
    await run(["bash", resolve(stage, "view", "build.sh"), stage], stage);
  },
  adoption:
    "Nothing to restart: the house's context-view workflow resolves ~/.local/lib/context-view/current once, at each run's first call, and runs every step from that release, so a run already going finishes on the release it began with, which the promote keeps while the run is open.",
  releases: { openRuns: ["context-view"] },
};

export const promote = (options?: Options) => release(spec, options);

if (import.meta.main) await main(spec.packageName, promote);
