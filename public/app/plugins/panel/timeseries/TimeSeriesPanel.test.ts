import { CompactTimeSeriesData, ReducerID } from '@grafana/data';
import { GraphDrawStyle, VizOrientation } from '@grafana/schema';

import { getRenderableCompactSeries } from './TimeSeriesPanel';
import { Options } from './panelcfg.gen';

describe('getRenderableCompactSeries', () => {
  const compactSeries = {} as CompactTimeSeriesData;
  const options = { legend: { calcs: [] } } as unknown as Options;

  it('keeps compact data for supported field configuration', () => {
    expect(
      getRenderableCompactSeries(
        compactSeries,
        {
          defaults: { custom: { drawStyle: GraphDrawStyle.Points } },
          overrides: [],
        },
        options
      )
    ).toBe(compactSeries);
  });

  it.each([
    {
      name: 'bar draw style',
      fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] },
      panelOptions: options,
    },
    {
      name: 'vertical orientation',
      fieldConfig: { defaults: {}, overrides: [] },
      panelOptions: { ...options, orientation: VizOrientation.Vertical },
    },
    {
      name: 'unsupported legend reducer',
      fieldConfig: { defaults: {}, overrides: [] },
      panelOptions: { ...options, legend: { ...options.legend, calcs: [ReducerID.p95] } },
    },
  ])('withholds compact data for $name', ({ fieldConfig, panelOptions }) => {
    expect(getRenderableCompactSeries(compactSeries, fieldConfig, panelOptions)).toBeUndefined();
  });

  it('withholds stale compact data for a full-format request', () => {
    expect(getRenderableCompactSeries(compactSeries, { defaults: {}, overrides: [] }, options, true)).toBeUndefined();
  });
});
