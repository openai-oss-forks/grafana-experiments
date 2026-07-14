import { createDataFrame, createTheme, dateTime, FieldType } from '@grafana/data';
import { LegendDisplayMode } from '@grafana/schema';

import { UnthemedTimeSeries } from './TimeSeries';

const frame = createDataFrame({
  fields: [
    { name: 'Time', type: FieldType.time, values: [0, 1] },
    { name: 'Value', type: FieldType.number, values: [1, 2] },
  ],
});
const timeRange = { from: dateTime(0), to: dateTime(1), raw: { from: dateTime(0), to: dateTime(1) } };

it.each([
  [undefined, 1],
  [false, 1],
  [true, 0.3],
])('sets focus opacity when highlighting is %s', (highlightSeriesOnHover, alpha) => {
  const component = new UnthemedTimeSeries({
    frames: [frame],
    height: 100,
    highlightSeriesOnHover,
    legend: { calcs: [], displayMode: LegendDisplayMode.List, placement: 'bottom', showLegend: false },
    replaceVariables: (value) => value,
    theme: createTheme(),
    timeRange,
    timeZone: 'utc',
    width: 100,
  });

  expect(component.prepConfig(frame, [frame], () => timeRange).getConfig().focus?.alpha).toBe(alpha);
});
