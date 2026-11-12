import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse, type AnyNode } from "acorn";

const MODULES = readdirSync(import.meta.dir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "testing.ts")
  .sort();

function spreadCalls(name: string): string[] {
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(join(import.meta.dir, name), "utf8"));
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const one of value) walk(one);
      return;
    }
    if (value === null || typeof value !== "object" || !("type" in value)) return;
    const node = value as AnyNode;
    if (node.type === "CallExpression" || node.type === "NewExpression")
      for (const arg of node.arguments) if (arg.type === "SpreadElement") found.push(`${name}: ...${js.slice(arg.argument.start, arg.argument.end)}`);
    const named = node.type === "Identifier" ? node.name : node.type === "Literal" ? node.value : node.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0]?.value.cooked : undefined;
    if (named === "apply" || named === "Reflect") found.push(`${name}: ${named}`);
    for (const child of Object.values(node)) walk(child);
  };
  walk(parse(js, { ecmaVersion: "latest", sourceType: "module" }));
  return found;
}

test("no module passes a list to a call as its arguments, which raises past the runtime's limit, but for one constant", () => {
  expect(MODULES.flatMap(spreadCalls)).toEqual(['view_reach.ts: ...HOLDS["not-loaded"][1]']);
});
