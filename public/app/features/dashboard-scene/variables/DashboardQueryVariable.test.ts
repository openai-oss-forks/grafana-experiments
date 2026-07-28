import { lastValueFrom, of } from 'rxjs';

import { SceneVariableValueChangedEvent, type VariableValueOption } from '@grafana/scenes';
import { ALL_VARIABLE_TEXT, ALL_VARIABLE_VALUE } from 'app/features/variables/constants';

import { DashboardQueryVariable } from './DashboardQueryVariable';

describe('DashboardQueryVariable', () => {
  const hostOptions: VariableValueOption[] = [
    { value: 'openai-aks-prod-db2.postgres.database.azure.com', label: 'Production database' },
    { value: 'openai-aks-prod-db3.postgres.database.azure.com', label: 'Second database' },
  ];

  it.each(['openai-aks-prod-db2', 'openai.*'])(
    'preserves the selected custom value %s when the available options refresh',
    async (selectedValue) => {
      const value = [selectedValue];
      const text = [selectedValue];
      const variable = createVariable({ value, text });

      await refreshOptions(variable, hostOptions);

      expect(variable.state.value).toBe(value);
      expect(variable.state.text).toBe(text);
      expect(variable.state.options).toEqual(hostOptions);
    }
  );

  it('preserves custom and exact selected values together', async () => {
    const value = ['openai-aks-prod-db2', hostOptions[1].value];
    const text = ['openai-aks-prod-db2', 'Second database'];
    const variable = createVariable({ value, text });

    await refreshOptions(variable, hostOptions);

    expect(variable.state.value).toBe(value);
    expect(variable.state.text).toBe(text);
  });

  it('preserves a single selected custom value', async () => {
    const variable = createVariable({ value: 'openai-aks-prod-db2', text: 'openai-aks-prod-db2', isMulti: false });

    await refreshOptions(variable, hostOptions);

    expect(variable.state.value).toBe('openai-aks-prod-db2');
    expect(variable.state.text).toBe('openai-aks-prod-db2');
  });

  it('preserves a selected custom value when refreshed options are empty', async () => {
    const value = ['openai-aks-prod-db2'];
    const text = ['openai-aks-prod-db2'];
    const variable = createVariable({ value, text });

    await refreshOptions(variable, []);

    expect(variable.state.value).toBe(value);
    expect(variable.state.text).toBe(text);
  });

  it('retains normal validation when custom values are disabled', async () => {
    const variable = createVariable({ allowCustomValue: false });

    await refreshOptions(variable, hostOptions);

    expect(variable.state.value).toEqual([ALL_VARIABLE_VALUE]);
    expect(variable.state.text).toEqual([ALL_VARIABLE_TEXT]);
  });

  it('normalizes the configured custom All value instead of preserving it as a selection', async () => {
    const variable = createVariable({ value: ['.*'], text: [ALL_VARIABLE_TEXT], allValue: '.*' });

    await refreshOptions(variable, hostOptions);

    expect(variable.state.value).toEqual([ALL_VARIABLE_VALUE]);
    expect(variable.state.text).toEqual([ALL_VARIABLE_TEXT]);
  });

  it('updates the label when a selected value is an exact refreshed option', async () => {
    const variable = createVariable({ value: [hostOptions[0].value], text: ['Stale label'] });

    await refreshOptions(variable, hostOptions);

    expect(variable.state.value).toEqual([hostOptions[0].value]);
    expect(variable.state.text).toEqual(['Production database']);
  });

  it('does not publish a value change for a preserved custom selection', async () => {
    const variable = createVariable();
    const onValueChanged = jest.fn();
    const subscription = variable.subscribeToEvent(SceneVariableValueChangedEvent, onValueChanged);

    await refreshOptions(variable, hostOptions);

    expect(onValueChanged).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });
});

function createVariable(state: Partial<DashboardQueryVariable['state']> = {}): DashboardQueryVariable {
  return new DashboardQueryVariable({
    name: 'dbhost',
    value: ['openai-aks-prod-db2'],
    text: ['openai-aks-prod-db2'],
    query: 'label_values(dbhost)',
    isMulti: true,
    includeAll: true,
    defaultToAll: true,
    allowCustomValue: true,
    ...state,
  });
}

async function refreshOptions(variable: DashboardQueryVariable, options: VariableValueOption[]): Promise<void> {
  jest.spyOn(variable, 'getValueOptions').mockReturnValue(of(options));
  await lastValueFrom(variable.validateAndUpdate());
}
