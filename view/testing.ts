import type { Json } from "review-workflow/view";

type Lists = Partial<Record<"ran" | "notRan" | "couldntTell" | "noCode" | "unloaded", number[]>>;

export function reachedFile(
  state = "read",
  { deletions = [], reason = null, ...lists }: Lists & { deletions?: [number, string, number | null][]; reason?: string | null } = {},
): { [key: string]: Json } {
  return {
    state,
    ...Object.fromEntries((["ran", "notRan", "couldntTell", "noCode", "unloaded"] as const).map((k) => [k, [...(lists[k] ?? [])]])),
    deletions: deletions.map(([after, s, by]) => ({ after, state: s, by })),
    ...(reason ? { reason } : {}),
  };
}

export const ALL_RAN = "All 2 of this change's changed source lines that map to code ran in at least one profiled drive.";
