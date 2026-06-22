import { CompactTimeSeriesData } from '@grafana/data';
import { GraphDrawStyle } from '@grafana/schema';

import { getRenderableCompactSeries } from './TimeSeriesPanel';
import { Options } from './panelcfg.gen';

describe('getRenderableCompactSeries', () => {
  const compactSeries = {} as CompactTimeSeriesData;
  const options = { legend: { calcs: [] } } as unknown as Options;

  it('keeps compact data for supported time series configuration', () => {
    expect(getRenderableCompactSeries(compactSeries, { defaults: {}, overrides: [] }, options)).toBe(compactSeries);
  });

  it('treats malformed legend reducers like the request policy does', () => {
    const malformedOptions = { legend: { calcs: 'last' } } as unknown as Options;
    expect(getRenderableCompactSeries(compactSeries, { defaults: {}, overrides: [] }, malformedOptions)).toBe(
      compactSeries
    );
  });

  it.each([
    {
      name: 'bar draw style',
      fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] },
      hasFullFormatRequest: false,
    },
    {
      name: 'full-format request',
      fieldConfig: { defaults: {}, overrides: [] },
      hasFullFormatRequest: true,
    },
  ])('withholds stale compact data for $name', ({ fieldConfig, hasFullFormatRequest }) => {
    expect(getRenderableCompactSeries(compactSeries, fieldConfig, options, hasFullFormatRequest)).toBeUndefined();
  });
});
