import { QueryVariable, type SceneVariable, SceneVariableSet } from '@grafana/scenes';
import { ALL_VARIABLE_VALUE } from 'app/features/variables/constants';

let selectedValueReadDepth = 0;

/**
 * Query admission can use the persisted selection without making dropdown
 * hydration globally appear complete to dependent variables.
 */
export class DashboardVariableSet extends SceneVariableSet {
  public override isVariableLoadingOrWaitingToUpdate(variable: SceneVariable): boolean {
    if (selectedValueReadDepth > 0 && hasUsableSelectedQueryValue(variable)) {
      return false;
    }

    return super.isVariableLoadingOrWaitingToUpdate(variable);
  }
}

export function runWithSelectedQueryValues<T>(action: () => T): T {
  selectedValueReadDepth++;
  try {
    return action();
  } finally {
    selectedValueReadDepth--;
  }
}

export function hasUsableSelectedQueryValue(variable: SceneVariable): boolean {
  if (!(variable instanceof QueryVariable)) {
    return false;
  }

  const value = variable.getValue();
  const selectedValues = Array.isArray(value) ? value : [value];

  if (
    selectedValues.length === 0 ||
    selectedValues.some((selectedValue) => selectedValue == null || selectedValue === '')
  ) {
    return false;
  }

  return selectedValues.every(
    (selectedValue) => selectedValue !== ALL_VARIABLE_VALUE || Boolean(variable.state.allValue)
  );
}
