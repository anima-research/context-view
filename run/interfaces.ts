export type Outcome = "ran" | "moved" | "closed" | "doesnt-merge" | "needs-companion" | "arm-missing" | "couldnt-run";
export const EXIT: Record<Outcome, number> = { ran: 0, moved: 3, closed: 3, "doesnt-merge": 3, "needs-companion": 3, "arm-missing": 3, "couldnt-run": 2 };
