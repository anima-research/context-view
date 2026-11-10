// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLEET_SUBSCRIPTION, fleetChildren, laneRecipe } from '../lib/strategies/driver.ts';
import { configurations } from '../lib/strategies/script.ts';

test('a fleet run\'s parent recipe starts each child of its configuration, autoStart, from a recipe of its own, its data under the run\'s store and its model on the stand-in\'s /empty route', () => {
  const configuration = configurations().Hfleet;
  assert.deepEqual(configuration.fleet.map((c) => c.name), ['src', 'dst']);
  const fleet = fleetChildren({ configuration, work: '/w', storeDir: '/s', standinUrl: 'http://127.0.0.1:9' });
  assert.deepEqual(fleet.map((f) => [f.name, f.recipePath, f.dataDir, f.env]), [
    ['src', '/w/fleet-src.json', '/s/fleet/src', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/empty' }],
    ['dst', '/w/fleet-dst.json', '/s/fleet/dst', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/empty' }],
  ]);
  assert.equal(fleet[0].recipe.agent.name, 'src');
  assert.equal(fleet[0].recipe.extensions, undefined, 'a child loads no harness module');
  const recipe = laneRecipe({ configuration, control: '/c.sock', channels: ['chat'], boot: 1, fleet });
  assert.deepEqual(recipe.modules.fleet, { children: fleet.map((f) => ({ name: f.name, recipe: f.recipePath, dataDir: f.dataDir, autoStart: true, subscription: FLEET_SUBSCRIPTION, env: f.env })) });
  assert.equal(laneRecipe({ configuration: configurations().H1, control: '/c.sock', channels: ['chat'], boot: 1 }).modules.fleet, undefined, 'a run with no children names no fleet module');
});
