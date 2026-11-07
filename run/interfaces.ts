// What the context view's run side shares with the house's context-view workflow, which calls it: the outcomes a run
// comes out with, and the exit code each gives. See AGENTS.md, run/'s "Exit codes and outcomes".
export type Outcome = "ran" | "moved" | "closed" | "doesnt-merge" | "needs-companion" | "arm-missing" | "couldnt-run";
export const EXIT: Record<Outcome, number> = { ran: 0, moved: 3, closed: 3, "doesnt-merge": 3, "needs-companion": 3, "arm-missing": 3, "couldnt-run": 2 };
