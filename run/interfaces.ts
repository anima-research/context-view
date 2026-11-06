// What the context view's run side shares with the workflow that calls it (review-workflow's workflow:context-view):
// the outcomes a run comes out with, and the exit code each gives. See AGENTS.md, "Exit codes".
export type Outcome = "ran" | "moved" | "closed" | "doesnt-merge" | "needs-companion" | "arm-missing" | "couldnt-run";
export const EXIT: Record<Outcome, number> = { ran: 0, moved: 3, closed: 3, "doesnt-merge": 3, "needs-companion": 3, "arm-missing": 3, "couldnt-run": 2 };
