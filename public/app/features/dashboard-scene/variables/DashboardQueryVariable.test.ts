import { lastValueFrom, of } from 'rxjs';

import {
  SceneObjectBase,
  SceneVariableValueChangedEvent,
  type SceneObjectState,
  type VariableValueOption,
} from '@grafana/scenes';
import { ALL_VARIABLE_TEXT, ALL_VARIABLE_VALUE } from 'app/features/variables/constants';

import { DashboardQueryVariable, PRESERVE_CUSTOM_REGEX_VALUES_DASHBOARD_TAG } from './DashboardQueryVariable';
import { DashboardVariableSet } from './DashboardVariableSet';

interface TestDashboardState extends SceneObjectState {
  tags: string[];
  $variables: DashboardVariableSet;
}

class TestDashboard extends SceneObjectBase<TestDashboardState> {}

describe('DashboardQueryVariable', () => {
  it.each(['engine-.*', '^engine-(a|b)$', '/engine-[ab]+/i'])(
    'preserves the opted-in custom regex value %s when refreshed options contain no exact match',
    async (regexValue) => {
      const value = [regexValue];
      const text = [regexValue];
      const { variable } = createVariable({ value, text });

      await refreshOptions(variable, engineOptions);

      expect(variable.state.value).toBe(value);
      expect(variable.state.text).toBe(text);
    }
  );

  it('preserves an opted-in regex value when the refreshed options are empty', async () => {
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

  it('preserves an opted-in single-value regex', async () => {
    const { variable } = createVariable({
      value: 'engine-.*',
      text: 'regex label',
      isMulti: false,
    });

    await refreshOptions(variable, engineOptions);

    expect(variable.state.value).toBe('engine-.*');
    expect(variable.state.text).toBe('regex label');
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

  it('retains the upstream fallback behavior for dashboards without the opt-in tag', async () => {
    const { variable } = createVariable({}, []);

    await refreshOptions(variable, engineOptions);

    expect(variable.state.value).toEqual([ALL_VARIABLE_VALUE]);
    expect(variable.state.text).toEqual([ALL_VARIABLE_TEXT]);
  });

  it.each([false, undefined])(
    'retains the upstream fallback behavior when allowCustomValue is %s',
    async (allowCustomValue) => {
      const { variable } = createVariable({ allowCustomValue });

      await refreshOptions(variable, engineOptions);

      expect(variable.state.value).toEqual([ALL_VARIABLE_VALUE]);
      expect(variable.state.text).toEqual([ALL_VARIABLE_TEXT]);
    }
  );

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

function createVariable(
  state: Partial<DashboardQueryVariable['state']> = {},
  tags = [PRESERVE_CUSTOM_REGEX_VALUES_DASHBOARD_TAG]
) {
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
  const dashboard = new TestDashboard({
    tags,
    $variables: new DashboardVariableSet({ variables: [variable] }),
  });

  return { dashboard, variable };
}

async function refreshOptions(variable: DashboardQueryVariable, options: VariableValueOption[]) {
  jest.spyOn(variable, 'getValueOptions').mockReturnValue(of(options));
  await lastValueFrom(variable.validateAndUpdate());
}
