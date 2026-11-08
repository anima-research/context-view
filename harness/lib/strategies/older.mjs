// What an older connectome-host release lacks that the harness reads, and what it reads there instead. Each fallback is
// keyed on the thing missing, so a candidate, which has them all, never reaches one; only a checkpoint written by an
// older release does, and no fallback is reached on a path a candidate's run records or judges.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// `src/model-limits.ts`, which hostFacts reads the model's window from, ships in connectome-host 0.16.0. Before it the
// host names no window the harness can read, so the line gives none, and `windowFor` takes the candidate's.
export function modelLimitsLine(hostDir, src) {
  return existsSync(join(hostDir, 'src', 'model-limits.ts'))
    ? `const { getDefaultModelLimits } = await import(${src('model-limits.ts')});`
    : 'const getDefaultModelLimits = () => null;';
}

// The window an older release's checkpoint drive runs under, where its host knows none: the candidate's for the same
// configuration. It sets only the stand-in's refusal past the window, never what the release itself writes.
export function windowFor(facts, candidateFacts) {
  if (typeof facts.window === 'number') return facts;
  const window = candidateFacts().window;
  return typeof window === 'number' ? { ...facts, window } : facts;
}

// agent-framework's `listAgents`, which ships in 0.30.0 (none at 0.29.0), and before it its private `agents` map, by
// name.
export function agentRecords(framework, opts) {
  if (typeof framework?.listAgents === 'function') return framework.listAgents(opts) ?? [];
  return framework?.agents instanceof Map ? [...framework.agents.keys()].map((name) => ({ name })) : [];
}

// agent-framework's `getPrimaryAgentName`, which ships in 0.30.0. Before it, the recipe's one agent is the primary.
export function primaryAgentName(framework) {
  if (typeof framework.getPrimaryAgentName === 'function') return framework.getPrimaryAgentName();
  const agents = agentRecords(framework);
  return agents.length === 1 ? agents[0].name : null;
}
