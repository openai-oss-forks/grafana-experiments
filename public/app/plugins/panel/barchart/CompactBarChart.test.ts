import uPlot from 'uplot';

import { CompactTimeSeriesData, FieldConfigSource, FieldMatcherID } from '@grafana/data';
import { GraphDrawStyle, StackingMode, VisibilityMode, VizOrientation } from '@grafana/schema';
import { measureText, UPLOT_AXIS_FONT_SIZE } from '@grafana/ui';
import { formatCompactBarTimeTicks } from 'app/core/components/TimeSeries/utils';

import {
  buildCompactBarFieldConfig,
  createCompactTickFilter,
  createCompactRotationPadding,
  getRenderableCompactBarSeries,
} from './CompactBarChart';
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

  it('reserves plot-edge space whenever tick labels are rotated', () => {
    expect(createCompactRotationPadding(0)).toBeUndefined();
    const labelWidth = measureText('00:00:00.000', UPLOT_AXIS_FONT_SIZE).width;
    expect(createCompactRotationPadding(45)).toEqual([
      UPLOT_AXIS_FONT_SIZE,
      Math.ceil(Math.cos(Math.PI / 4) * labelWidth),
      Math.ceil(Math.sin(Math.PI / 4) * labelWidth),
      0,
    ]);
    expect(createCompactRotationPadding(-45)).toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it('keeps filtered time ticks hidden for positive and negative label spacing', () => {
    const splits = [1_718_644_800_000, 1_718_644_860_000, 1_718_644_920_000, 1_718_644_980_000, 1_718_645_040_000];
    const plot = {
      axes: [{ scale: 'x' }],
      bbox: { width: 200 * uPlot.pxRatio, height: 100 * uPlot.pxRatio },
      scales: { x: { ori: 0 } },
    } as unknown as uPlot;

    expect(createCompactTickFilter(0)).toBeUndefined();
    const positive = createCompactTickFilter(100)!(plot, splits, 0, 0, 0);
    const negative = createCompactTickFilter(-100)!(plot, splits, 0, 0, 0);

    expect(positive).toEqual([splits[0], null, null, splits[3], null]);
    expect(negative).toEqual([null, splits[1], null, null, splits[4]]);
    for (const filtered of [positive, negative]) {
      const labels = formatCompactBarTimeTicks(filtered, 'utc', 60_000);
      expect(labels.filter((label) => label != null)).not.toContain('Invalid date');
      expect(labels).toEqual(filtered.map((value) => (value == null ? null : expect.any(String))));
    }
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

  it('ignores field options that the full Bar chart owns at panel level', () => {
    const configured: FieldConfigSource = {
      defaults: {
        noValue: '5',
        custom: { drawStyle: GraphDrawStyle.Line, stacking: { mode: StackingMode.Normal, group: 'saved' } },
      },
      overrides: [
        {
          matcher: { id: FieldMatcherID.byName, options: 'requests' },
          properties: [
            { id: 'noValue', value: '7' },
            { id: 'custom.stacking', value: { mode: StackingMode.Normal, group: 'override' } },
            { id: 'custom.barWidthFactor', value: 0.2 },
            { id: 'custom.drawStyle', value: GraphDrawStyle.Line },
            { id: 'custom.lineColor', value: 'red' },
          ],
        },
      ],
    };

    const adapted = buildCompactBarFieldConfig(configured, options);

    expect(adapted.defaults.noValue).toBe('5');
    expect(adapted.defaults.custom?.stacking).toEqual({ mode: StackingMode.Percent, group: '__compact_barchart' });
    expect(adapted.overrides[0].properties).toEqual([
      { id: 'noValue', value: '7' },
      { id: 'custom.lineColor', value: 'red' },
    ]);
    expect(configured.overrides[0].properties).toHaveLength(5);
    expect(getRenderableCompactBarSeries(compactSeries, configured, options)).toBe(compactSeries);
  });
});
