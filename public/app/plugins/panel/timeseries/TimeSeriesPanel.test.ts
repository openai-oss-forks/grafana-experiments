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

  it('withholds compact data while an unsupported field configuration is active', () => {
    expect(
      getRenderableCompactSeries(
        compactSeries,
        {
          defaults: { custom: { drawStyle: GraphDrawStyle.Bars } },
          overrides: [],
        },
        options
      )
    ).toBeUndefined();
  });

  it('withholds compact data for vertical orientation', () => {
    expect(
      getRenderableCompactSeries(
        compactSeries,
        { defaults: {}, overrides: [] },
        { ...options, orientation: VizOrientation.Vertical }
      )
    ).toBeUndefined();
  });

  it('withholds compact data for unsupported legend reducers', () => {
    expect(
      getRenderableCompactSeries(
        compactSeries,
        { defaults: {}, overrides: [] },
        {
          ...options,
          legend: { ...options.legend, calcs: [ReducerID.p95] },
        }
      )
    ).toBeUndefined();
  });
});
