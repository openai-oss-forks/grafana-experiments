import { lastValueFrom, of } from 'rxjs';

import { SceneVariableValueChangedEvent, type VariableValueOption } from '@grafana/scenes';
import { ALL_VARIABLE_TEXT, ALL_VARIABLE_VALUE } from 'app/features/variables/constants';

import { DashboardQueryVariable } from './DashboardQueryVariable';

describe('DashboardQueryVariable', () => {
  it.each(['engine-.*', '^engine-(a|b)$', '/engine-[ab]+/i'])(
    'preserves the custom regex value %s without a dashboard opt-in when refreshed options contain no exact match',
    async (regexValue) => {
      const value = [regexValue];
      const text = [regexValue];
      const { variable } = createVariable({ value, text });

      await refreshOptions(variable, engineOptions);

      expect(variable.state.value).toBe(value);
      expect(variable.state.text).toBe(text);
    }
  );

  it('preserves a regex value when the refreshed options are empty', async () => {
    const value = ['engine-.*'];
    const text = ['engine-.*'];
    const { variable } = createVariable({ value, text });

    await refreshOptions(variable, []);

    expect(variable.state.value).toBe(value);
    expect(variable.state.text).toBe(text);
  });

  it('keeps exact and regex values while dropping an unmatched plain value', async () => {
    const { variable } = createVariable({
      value: ['engine-a', 'engine-.*', 'missing-engine'],
      text: ['stale exact label', 'regex label', 'missing label'],
    });

    await refreshOptions(variable, engineOptions);

    expect(variable.state.value).toEqual(['engine-a', 'engine-.*']);
    expect(variable.state.text).toEqual(['Engine A', 'regex label']);
  });

  it('preserves a single-value regex', async () => {
    const { variable } = createVariable({
      value: 'engine-.*',
      text: 'regex label',
      isMulti: false,
    });

    await refreshOptions(variable, engineOptions);

    expect(variable.state.value).toBe('engine-.*');
    expect(variable.state.text).toBe('regex label');
  });

  it('uses the refreshed option when a single-value regex matches its label', async () => {
    const { variable } = createVariable({
      value: 'engine-.*',
      text: 'engine-.*',
      isMulti: false,
    });

    await refreshOptions(variable, [{ label: 'engine-.*', value: 'engine-a' }]);

    expect(variable.state.value).toBe('engine-a');
    expect(variable.state.text).toBe('engine-.*');
  });

  it('uses the refreshed label when a regex-like value is also an exact option', async () => {
    const value = ['engine-.*'];
    const { variable } = createVariable({ value, text: ['stale label'] });

    await refreshOptions(variable, [{ label: 'Exact regex label', value: 'engine-.*' }]);

    expect(variable.state.value).toBe(value);
    expect(variable.state.text).toEqual(['Exact regex label']);
  });

  it('does not publish a value change when an unchanged regex value is preserved', async () => {
    const value = ['engine-.*'];
    const text = ['regex label'];
    const { variable } = createVariable({ value, text });
    const onValueChanged = jest.fn();
    const subscription = variable.subscribeToEvent(SceneVariableValueChangedEvent, onValueChanged);

    await refreshOptions(variable, engineOptions);

    expect(variable.state.value).toBe(value);
    expect(variable.state.text).toBe(text);
    expect(onValueChanged).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('retains the upstream fallback behavior when allowCustomValue is false', async () => {
    const { variable } = createVariable({ allowCustomValue: false });

    await refreshOptions(variable, engineOptions);

    expect(variable.state.value).toEqual([ALL_VARIABLE_VALUE]);
    expect(variable.state.text).toEqual([ALL_VARIABLE_TEXT]);
  });

  it('preserves a regex when allowCustomValue uses its enabled default', async () => {
    const value = ['engine-.*'];
    const text = ['engine-.*'];
    const { variable } = createVariable({ value, text, allowCustomValue: undefined });

    await refreshOptions(variable, engineOptions);

    expect(variable.state.value).toBe(value);
    expect(variable.state.text).toBe(text);
  });

  it.each(['missing-engine', 'api.prod.example.com', 'engine-[', '/engine/z'])(
    'retains the upstream fallback behavior for the non-regex value %s',
    async (value) => {
      const { variable } = createVariable({ value: [value], text: [value] });

      await refreshOptions(variable, engineOptions);

      expect(variable.state.value).toEqual([ALL_VARIABLE_VALUE]);
      expect(variable.state.text).toEqual([ALL_VARIABLE_TEXT]);
    }
  );
});

const engineOptions: VariableValueOption[] = [
  { label: 'Engine A', value: 'engine-a' },
  { label: 'Engine B', value: 'engine-b' },
];

function createVariable(state: Partial<DashboardQueryVariable['state']> = {}) {
  const variable = new DashboardQueryVariable({
    name: 'engine',
    value: ['engine-.*'],
    text: ['engine-.*'],
    query: 'label_values(engine)',
    isMulti: true,
    includeAll: true,
    defaultToAll: true,
    allowCustomValue: true,
    ...state,
  });

  return { variable };
}

async function refreshOptions(variable: DashboardQueryVariable, options: VariableValueOption[]) {
  jest.spyOn(variable, 'getValueOptions').mockReturnValue(of(options));
  await lastValueFrom(variable.validateAndUpdate());
}
