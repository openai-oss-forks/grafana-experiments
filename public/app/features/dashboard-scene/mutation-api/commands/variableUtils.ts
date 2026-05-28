/**
 * Shared variable utilities for mutation commands.
 *
 * Contains helpers used across add/remove/update variable commands.
 */

import type { SceneVariableSet, sceneGraph } from '@grafana/scenes';

import { DashboardVariableSet } from '../../variables/DashboardVariableSet';

/**
 * Replace the dashboard's variable set with a new set containing the given variables.
 * This ensures consistent lifecycle behavior across add/remove/update operations.
 */
export function replaceVariableSet(
  scene: Parameters<typeof sceneGraph.getVariables>[0],
  variables: ReturnType<typeof sceneGraph.getVariables>['state']['variables']
): SceneVariableSet {
  const newVarSet = new DashboardVariableSet({ variables });
  scene.setState({ $variables: newVarSet });
  newVarSet.activate();
  return newVarSet;
}
