import { render, screen } from '@testing-library/react';

import { createDataFrame, FieldType } from '@grafana/data';
import { TooltipDisplayMode } from '@grafana/schema';

import { TimeSeriesTooltip } from './TimeSeriesTooltip';

it('separates the focused series from a multi-series tooltip', () => {
  const series = createDataFrame({
    fields: [
      { name: 'Time', type: FieldType.time, values: [0] },
      { name: 'series-a', type: FieldType.number, values: [1] },
      { name: 'series-b', type: FieldType.number, values: [2] },
    ],
  });
  series.fields.forEach((field, index) => {
    field.display = (value) => ({
      color: index === 2 ? '#ff0000' : '#00ff00',
      numeric: Number(value),
      text: String(value),
    });
  });

  render(
    <TimeSeriesTooltip
      series={series}
      dataIdxs={[0, 0, 0]}
      seriesIdx={2}
      mode={TooltipDisplayMode.Multi}
      isPinned={false}
      dataLinks={[]}
      highlightSeriesOnHover
    />
  );

  const focusedSeries = screen.getByTestId('timeseries-tooltip-focused-series');
  expect(focusedSeries).toHaveTextContent('Focused series');
  expect(focusedSeries).toHaveTextContent('series-b');
  expect(screen.getAllByText('series-b')).toHaveLength(1);
  expect(screen.getByText('series-a')).toBeInTheDocument();
});
