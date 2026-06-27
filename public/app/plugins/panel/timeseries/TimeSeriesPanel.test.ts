import { CompactTimeSeriesData } from '@grafana/data';
import { GraphDrawStyle, StackingMode } from '@grafana/schema';

import { getRenderableCompactSeries } from './TimeSeriesPanel';
import { Options } from './panelcfg.gen';

describe('getRenderableCompactSeries', () => {
  const compactSeries = { series: [{}] } as unknown as CompactTimeSeriesData;
  const emptyCompactSeries = { series: [] } as unknown as CompactTimeSeriesData;
  const options = { legend: { calcs: [] } } as unknown as Options;

  it('keeps compact data for supported time series configuration', () => {
    expect(getRenderableCompactSeries(compactSeries, { defaults: {}, overrides: [] }, options)).toBe(compactSeries);
  });

  it('routes empty compact responses through the standard no-data state', () => {
    expect(getRenderableCompactSeries(emptyCompactSeries, { defaults: {}, overrides: [] }, options)).toBeUndefined();
  });

  it('keeps compact data for supported TimeSeries bars', () => {
    expect(
      getRenderableCompactSeries(
        compactSeries,
        {
          defaults: {
            custom: {
              drawStyle: GraphDrawStyle.Bars,
              barWidthFactor: 0.8,
              stacking: { mode: StackingMode.Percent, group: 'A' },
            },
          },
          overrides: [],
        },
        options
      )
    ).toBe(compactSeries);
  });

  it('treats malformed legend reducers like the request policy does', () => {
    const malformedOptions = { legend: { calcs: 'last' } } as unknown as Options;
    expect(getRenderableCompactSeries(compactSeries, { defaults: {}, overrides: [] }, malformedOptions)).toBe(
      compactSeries
    );
  });

  it('withholds stale compact data for a full-format request', () => {
    expect(getRenderableCompactSeries(compactSeries, { defaults: {}, overrides: [] }, options, true)).toBeUndefined();
  });
});
