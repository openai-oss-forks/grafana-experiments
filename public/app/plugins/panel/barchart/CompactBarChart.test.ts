import { CompactTimeSeriesData, FieldConfigSource } from '@grafana/data';
import { GraphDrawStyle, StackingMode, VisibilityMode, VizOrientation } from '@grafana/schema';

import { buildCompactBarFieldConfig, getRenderableCompactBarSeries } from './CompactBarChart';
import { Options } from './panelcfg.gen';

describe('compact standalone Bar chart', () => {
  const compactSeries = {} as CompactTimeSeriesData;
  const fieldConfig: FieldConfigSource = {
    defaults: { custom: { fillOpacity: 80, lineWidth: 2 } },
    overrides: [],
  };
  const options = {
    orientation: VizOrientation.Vertical,
    stacking: StackingMode.Percent,
    showValue: VisibilityMode.Auto,
    groupWidth: 0.7,
    barWidth: 0.9,
    barRadius: 0.2,
    fullHighlight: true,
    xTickLabelRotation: 0,
    xTickLabelMaxLength: 0,
    xTickLabelSpacing: 0,
    legend: { calcs: ['min', 'max'] },
    tooltip: { mode: 'multi' },
  } as unknown as Options;

  it('keeps supported compact data unless the final request is full JSON', () => {
    expect(getRenderableCompactBarSeries(compactSeries, fieldConfig, options)).toBe(compactSeries);
    expect(getRenderableCompactBarSeries(compactSeries, fieldConfig, options, true)).toBeUndefined();
  });

  it('withholds compact data for an explicit or categorical X field', () => {
    const unsupported = { ...options, xField: 'category' };
    expect(getRenderableCompactBarSeries(compactSeries, fieldConfig, unsupported)).toBeUndefined();
  });

  it('adapts panel-level bar settings without mutating the saved field configuration', () => {
    const adapted = buildCompactBarFieldConfig(fieldConfig, options);
    expect(adapted).not.toBe(fieldConfig);
    expect(adapted.defaults.custom).toMatchObject({
      drawStyle: GraphDrawStyle.Bars,
      showPoints: VisibilityMode.Never,
      showValues: true,
      barWidthFactor: 0.9,
      stacking: { mode: StackingMode.Percent },
      axisSoftMin: 0,
      axisSoftMax: 0,
    });
    expect(fieldConfig.defaults.custom).toEqual({ fillOpacity: 80, lineWidth: 2 });
  });
});
