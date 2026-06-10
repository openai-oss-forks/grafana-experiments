// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/querybuilder/components/PromQueryBuilderOptions.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { select } from 'react-select-event';

import { CoreApp } from '@grafana/data';

import { PromQuery } from '../../types';
import { getQueryWithDefaults } from '../state';

import { PromQueryBuilderOptions } from './PromQueryBuilderOptions';

describe('PromQueryBuilderOptions', () => {
  it('Can change query type', async () => {
    const { props } = setup();

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    expect(screen.getByLabelText('Range')).toBeChecked();

    await userEvent.click(screen.getByLabelText('Instant'));

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      instant: true,
      range: false,
      exemplar: false,
    });
  });

  it('Can set query type to "Both" on render for PanelEditor', async () => {
    setup({ instant: true, range: true });

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    expect(screen.getByLabelText('Both')).toBeChecked();
  });

  it('Can set query type to "Both" on render for Explorer', async () => {
    setup({ instant: true, range: true }, CoreApp.Explore);

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    expect(screen.getByLabelText('Both')).toBeChecked();
  });

  it('Legend format default to Auto', () => {
    setup();
    expect(screen.getByText('Legend: Auto')).toBeInTheDocument();
  });

  it('Can change step size', async () => {
    const { props } = setup();

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    const stepSizeSelect = screen.getByLabelText('Step size combobox');
    await waitFor(() => select(stepSizeSelect, '30m', { container: document.body }));

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      stepSize: '30m',
    });
  });

  it('Clears step size when min step is committed above it', async () => {
    const { props } = setup({ interval: '1m', stepSize: '30m' });

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    const minStepInput = screen.getByLabelText('Min step text box, set lower limit for the step parameter');
    await userEvent.clear(minStepInput);
    await userEvent.type(minStepInput, '1h');
    await userEvent.tab();

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      interval: '1h',
      stepSize: undefined,
    });
  });

  it('Can change legend format to verbose', async () => {
    const { props } = setup();

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    let legendModeSelect = screen.getByLabelText('Legend combobox');
    await userEvent.click(legendModeSelect);

    await waitFor(() => select(legendModeSelect, 'Verbose', { container: document.body }));

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      legendFormat: '',
    });
  });

  it('Can change legend format to custom', async () => {
    const { props } = setup();

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    let legendModeSelect = screen.getByLabelText('Legend combobox');
    await userEvent.click(legendModeSelect);

    await waitFor(() => select(legendModeSelect, 'Custom', { container: document.body }));

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      legendFormat: '{{label_name}}',
    });
  });

  it('Handle defaults with undefined range', () => {
    setup(getQueryWithDefaults({ refId: 'A', expr: '', range: undefined, instant: true }, CoreApp.Dashboard));

    expect(screen.getByText('Type: Instant')).toBeInTheDocument();
  });

  it('Should show "Exemplars: false" by default', () => {
    setup();
    expect(screen.getByText('Exemplars: false')).toBeInTheDocument();
  });

  it('Should show "Exemplars: false" when query has "Exemplars: false"', () => {
    setup({ exemplar: false });
    expect(screen.getByText('Exemplars: false')).toBeInTheDocument();
  });

  it('Should show "Exemplars: true" when query has "Exemplars: true"', () => {
    setup({ exemplar: true });
    expect(screen.getByText('Exemplars: true')).toBeInTheDocument();
  });
});

function setup(queryOverrides: Partial<PromQuery> = {}, app: CoreApp = CoreApp.PanelEditor) {
  const props = {
    app,
    query: {
      ...getQueryWithDefaults(
        {
          refId: 'A',
          expr: '',
          range: true,
          instant: false,
        } as PromQuery,
        CoreApp.PanelEditor
      ),
      ...queryOverrides,
    },
    onRunQuery: jest.fn(),
    onChange: jest.fn(),
    uiOptions: {
      exemplars: true,
      type: true,
      format: true,
      minStep: true,
      legend: true,
      resolution: true,
    },
  };

  const { container } = render(<PromQueryBuilderOptions {...props} />);
  return { container, props };
}
