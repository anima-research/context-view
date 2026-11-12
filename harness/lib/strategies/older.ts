import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { namedWindow } from './lane.ts';

interface Framework { listAgents?: (opts?: { includeEnded?: boolean }) => Array<{ name: string }> | null | undefined; agents?: unknown; getPrimaryAgentName?: () => string | null }

// `src/model-limits.ts`, which hostFacts reads the model's window from, ships in connectome-host 0.16.0. Before it the
// host names no window the harness can read, so the line gives none.
export function modelLimitsLine(hostDir: string, src: (file: string) => string) {
  return existsSync(join(hostDir, 'src', 'model-limits.ts'))
    ? `const { getDefaultModelLimits } = await import(${src('model-limits.ts')});`
    : 'const getDefaultModelLimits = () => null;';
}

export async function borrowedWindow(facts: { window?: unknown }, configuration: { windowTokens?: unknown }, read: () => number | null | Promise<number | null>): Promise<number | null | undefined> {
  if (namedWindow(configuration, facts) != null) return undefined;
  return read();
}

// agent-framework's `listAgents`, which ships in 0.30.0 (none at 0.29.0), and before it its private `agents` map, by
// name.
export function agentRecords(framework: Framework | null | undefined, opts?: { includeEnded?: boolean }): Array<{ name: string }> {
  if (typeof framework?.listAgents === 'function') return framework.listAgents(opts) ?? [];
  return framework?.agents instanceof Map ? [...framework.agents.keys()].map((name) => ({ name })) : [];
}

// agent-framework's `getPrimaryAgentName`, which ships in 0.30.0. Before it, the recipe's one agent is the primary.
export function primaryAgentName(framework: Framework) {
  if (typeof framework.getPrimaryAgentName === 'function') return framework.getPrimaryAgentName();
  const agents = agentRecords(framework);
  return agents.length === 1 ? agents[0].name : null;
}
