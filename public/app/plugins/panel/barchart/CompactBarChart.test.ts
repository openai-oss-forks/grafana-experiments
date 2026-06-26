import { render } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import uPlot from 'uplot';

import { CompactTimeSeriesData, FieldConfigSource, FieldMatcherID, PanelProps } from '@grafana/data';
import { setPluginImportUtils } from '@grafana/runtime';
import { GraphDrawStyle, StackingMode, TooltipDisplayMode, VisibilityMode, VizOrientation } from '@grafana/schema';
import { measureText, UPLOT_AXIS_FONT_SIZE } from '@grafana/ui';
import { TimeSeries } from 'app/core/components/TimeSeries/TimeSeries';
import { CompactTooltipPlugin } from 'app/plugins/panel/timeseries/CompactTooltipPlugin';

import {
  buildCompactBarFieldConfig,
  CompactBarChart,
  createCompactRotationPadding,
  createCompactTickFilter,
  getRenderableCompactBarSeries,
} from './CompactBarChart';
import { Options } from './panelcfg.gen';

jest.mock('app/core/components/TimeSeries/TimeSeries', () => ({ TimeSeries: jest.fn(() => null) }));

setPluginImportUtils({
  importPanelPlugin: jest.fn(),
  getPanelPluginFromCache: jest.fn(() => ({ fieldConfigRegistry: { list: () => [] } }) as never),
});

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

  it('forwards plot selections to the dashboard time range', () => {
    const onChangeTimeRange = jest.fn();

    render(
      createElement(CompactBarChart, {
        compactSeries,
        data: { structureRev: 1 },
        fieldConfig: {
          ...fieldConfig,
          defaults: { ...fieldConfig.defaults, custom: { ...fieldConfig.defaults.custom, axisLabel: 'Timestamp' } },
        },
        options: { ...options, tooltip: { ...options.tooltip, mode: TooltipDisplayMode.None } },
        timeRange: {},
        timeZone: 'utc',
        width: 800,
        height: 400,
        replaceVariables: (value: string) => value,
        onChangeTimeRange,
      } as unknown as PanelProps<Options> & { compactSeries: CompactTimeSeriesData })
    );

    const timeSeriesProps = (TimeSeries as unknown as jest.Mock).mock.calls.at(-1)?.[0];
    const tooltip = timeSeriesProps.compactChildren({}, {}) as ReactElement<{ queryZoom?: unknown }>;
    expect(tooltip.type).toBe(CompactTooltipPlugin);
    expect(tooltip.props.queryZoom).toBe(onChangeTimeRange);
    expect(timeSeriesProps.options.compactXAxisConfig.label).toBe('Timestamp');
    expect(timeSeriesProps.options.compactGroupedBarTickSpacing).toBe(0);
  });

  it('keeps horizontal Bar chart label spacing on the horizontal value axis', () => {
    render(
      createElement(CompactBarChart, {
        compactSeries,
        data: { structureRev: 1 },
        fieldConfig,
        options: { ...options, orientation: VizOrientation.Horizontal, xTickLabelSpacing: 100 },
        timeRange: {},
        timeZone: 'utc',
        width: 800,
        height: 400,
        replaceVariables: (value: string) => value,
      } as unknown as PanelProps<Options> & { compactSeries: CompactTimeSeriesData })
    );

    const timeSeriesProps = (TimeSeries as unknown as jest.Mock).mock.calls.at(-1)?.[0];
    expect(timeSeriesProps.options.compactGroupedBarTickSpacing).toBe(0);
    expect(timeSeriesProps.options.compactValueAxisConfig.filter).toEqual(expect.any(Function));
  });

  it('withholds compact data for an explicit or categorical X field', () => {
    const unsupported = { ...options, xField: 'category' };
    expect(getRenderableCompactBarSeries(compactSeries, fieldConfig, unsupported)).toBeUndefined();
  });

  it('reserves plot-edge space whenever tick labels are rotated', () => {
    const labelWidth = measureText('00:00:00.000', UPLOT_AXIS_FONT_SIZE).width;
    expect(createCompactRotationPadding(0)).toBeUndefined();
    expect(createCompactRotationPadding(0, false)).toBeUndefined();
    const crossPadding = Math.ceil((Math.sin(Math.PI / 4) * UPLOT_AXIS_FONT_SIZE) / 2);
    expect(createCompactRotationPadding(45)).toEqual([
      UPLOT_AXIS_FONT_SIZE,
      Math.ceil(Math.cos(Math.PI / 4) * labelWidth) + crossPadding,
      Math.ceil(Math.sin(Math.PI / 4) * labelWidth),
      crossPadding,
    ]);
    expect(createCompactRotationPadding(-45)).toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it('matches legacy horizontal-axis spacing and negative anchoring', () => {
    const splits = [0, 1, 2, 3, 4];
    const plot = {
      axes: [{ scale: 'y' }],
      bbox: { width: 200 * uPlot.pxRatio, height: 1000 * uPlot.pxRatio },
      scales: { y: { ori: 0, dir: 1 } },
    } as unknown as uPlot;

    expect(createCompactTickFilter(0)).toBeUndefined();
    expect(createCompactTickFilter(100)!(plot, splits, 0, 0, 0)).toEqual([splits[0], null, null, splits[3], null]);
    expect(createCompactTickFilter(-100)!(plot, splits, 0, 0, 0)).toEqual([null, splits[1], null, null, splits[4]]);
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
