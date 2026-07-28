import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lastValueFrom, of } from 'rxjs';

import { VariableHide } from '@grafana/data';
import { SceneGridLayout, SceneVariable, SceneVariableSet, ScopesVariable, TextBoxVariable } from '@grafana/scenes';

import { DashboardQueryVariable } from '../variables/DashboardQueryVariable';
import { DashboardScene } from './DashboardScene';
import { VariableControls } from './VariableControls';
import { DefaultGridLayoutManager } from './layout-default/DefaultGridLayoutManager';

jest.mock('@grafana/runtime', () => {
  const runtime = jest.requireActual('@grafana/runtime');
  return {
    ...runtime,
    config: {
      ...runtime.config,
      featureToggles: {
        dashboardNewLayouts: true,
      },
    },
  };
});

describe('VariableControls', () => {
  it('should not show scopes variable label but should mount its component', () => {
    const scopesVariable = new ScopesVariable({ hide: VariableHide.hideVariable, name: '__scopes' });
    const variables = [scopesVariable];
    const dashboard = buildScene(variables);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);
    expect(screen.queryByText('__scopes')).not.toBeInTheDocument();
  });

  it('should not show scopes variable in edit mode but should mount its component', () => {
    const scopesVariable = new ScopesVariable({ hide: VariableHide.hideVariable, name: '__scopes' });
    const variables = [scopesVariable];
    const dashboard = buildScene(variables);
    dashboard.activate();
    dashboard.setState({ isEditing: true });

    render(<VariableControls dashboard={dashboard} />);
    expect(screen.queryByText('__scopes')).not.toBeInTheDocument();
  });

  it('should not render regular hidden variables', () => {
    const hiddenVariable = new TextBoxVariable({
      name: 'HiddenVar',
      hide: VariableHide.hideVariable,
    });
    const variables = [hiddenVariable];
    const dashboard = buildScene(variables);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    expect(screen.queryByText('HiddenVar')).not.toBeInTheDocument();
  });

  it('should render regular hidden variables but not scopes variable in edit mode', async () => {
    const scopesVariable = new ScopesVariable({ hide: VariableHide.hideVariable, name: '__scopes' });
    const hiddenVariable = new TextBoxVariable({ name: 'HiddenVar', hide: VariableHide.hideVariable });
    const variables = [scopesVariable, hiddenVariable];
    const dashboard = buildScene(variables);
    dashboard.activate();

    dashboard.setState({ isEditing: true });
    render(<VariableControls dashboard={dashboard} />);

    expect(await screen.findByText('HiddenVar')).toBeInTheDocument();
    expect(screen.queryByText('__scopes')).not.toBeInTheDocument();
  });

  it('should not render variables hidden in controls menu in edit mode', async () => {
    const dashboard = buildScene([new TextBoxVariable({ name: 'TextVarControls', hide: VariableHide.inControlsMenu })]);
    dashboard.activate();

    dashboard.setState({ isEditing: true });
    render(<VariableControls dashboard={dashboard} />);

    expect(screen.queryByText('TextVarControls')).not.toBeInTheDocument();
  });

  it('should render visible variables in edit mode', async () => {
    const dashboard = buildScene([new TextBoxVariable({ name: 'TextVarVisible', hide: VariableHide.dontHide })]);
    dashboard.activate();

    dashboard.setState({ isEditing: true });
    render(<VariableControls dashboard={dashboard} />);

    expect(await screen.findByText('TextVarVisible')).toBeInTheDocument();
  });

  it('prefills a selected multi-value query variable when its value is clicked', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable();
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    await user.click(await screen.findByText('dbhost-prod-1'));

    expect(screen.getByRole('combobox')).toHaveValue('dbhost-prod-1');
    expect(variable.state.value).toEqual(['dbhost-prod-1']);
  });

  it('prefills a selected multi-value query variable when its value is activated by keyboard', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable();
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    const selectedValue = await screen.findByRole('button', { name: 'dbhost-prod-1' });

    await user.tab();

    expect(selectedValue).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(screen.getByRole('combobox')).toHaveValue('dbhost-prod-1');
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(variable.state.value).toEqual(['dbhost-prod-1']);
  });

  it('replaces the clicked multi-value query variable instead of adding another value', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable();
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    await user.click(await screen.findByText('dbhost-prod-1'));
    await user.keyboard('{End}{Backspace}2');

    expect(screen.getByRole('combobox')).toHaveValue('dbhost-prod-2');

    await user.keyboard('{Enter}');

    expect(variable.state.value).toEqual(['dbhost-prod-1']);

    await user.click(document.body);

    expect(variable.state.value).toEqual(['dbhost-prod-2']);
  });

  it('commits an edited multi-value query variable when the picker loses focus', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable();
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    await user.click(await screen.findByText('dbhost-prod-1'));
    await user.keyboard('{End}{Backspace}2');
    await user.click(document.body);

    expect(variable.state.value).toEqual(['dbhost-prod-2']);
  });

  it('preserves other selections when an edited custom value is refreshed', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable({
      value: ['dbhost-custom', 'dbhost-prod-2'],
      text: ['dbhost-custom', 'dbhost-prod-2'],
    });
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    await user.click(await screen.findByText('dbhost-custom'));
    await user.keyboard('{End}-edited{Enter}');
    await user.click(document.body);

    expect(variable.state.value).toEqual(['dbhost-custom-edited', 'dbhost-prod-2']);

    await act(async () => {
      await lastValueFrom(variable.validateAndUpdate());
    });

    expect(variable.state.value).toEqual(['dbhost-custom-edited', 'dbhost-prod-2']);
  });

  it('does not duplicate another selected value when an edited value matches it', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable({
      value: ['dbhost-prod-1', 'dbhost-prod-2'],
      text: ['dbhost-prod-1', 'dbhost-prod-2'],
    });
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    await user.click(await screen.findByText('dbhost-prod-1'));
    await user.keyboard('{End}{Backspace}2{Enter}');
    await user.click(document.body);

    expect(variable.state.value).toEqual(['dbhost-prod-2']);
  });

  it('cancels value editing on Escape before adding another dropdown option', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable();
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    await user.click(await screen.findByText('dbhost-prod-1'));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'dbhost-prod-2' }));

    expect(await screen.findByRole('button', { name: 'dbhost-prod-2' })).toBeInTheDocument();

    await user.click(screen.getByRole('combobox'));
    await user.click(document.body);

    expect(variable.state.value).toEqual(['dbhost-prod-1', 'dbhost-prod-2']);
  });

  it('does not enter edit mode for a read-only query variable', async () => {
    const user = userEvent.setup();
    const variable = buildHostVariable({ isReadOnly: true });
    const dashboard = buildScene([variable]);
    dashboard.activate();

    render(<VariableControls dashboard={dashboard} />);

    await user.click(await screen.findByText('dbhost-prod-1'));

    expect(screen.getByRole('combobox', { hidden: true })).toBeDisabled();
    expect(screen.getByRole('combobox', { hidden: true })).toHaveValue('');
    expect(variable.state.value).toEqual(['dbhost-prod-1']);
  });
});

function buildHostVariable(state: Partial<DashboardQueryVariable['state']> = {}) {
  const options = [
    { value: 'dbhost-prod-1', label: 'dbhost-prod-1' },
    { value: 'dbhost-prod-2', label: 'dbhost-prod-2' },
  ];
  const variable = new DashboardQueryVariable({
    name: 'dbhost',
    value: ['dbhost-prod-1'],
    text: ['dbhost-prod-1'],
    options,
    query: 'label_values(dbhost)',
    isMulti: true,
    allowCustomValue: true,
    ...state,
  });

  jest.spyOn(variable, 'getValueOptions').mockReturnValue(of(options));

  return variable;
}

function buildScene(variables: SceneVariable[] = []) {
  const dashboard = new DashboardScene({
    $variables: new SceneVariableSet({ variables }),
    body: new DefaultGridLayoutManager({
      grid: new SceneGridLayout({
        children: [],
      }),
    }),
  });
  return dashboard;
}
