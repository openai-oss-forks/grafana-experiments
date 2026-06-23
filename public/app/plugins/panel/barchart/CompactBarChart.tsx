import { useMemo } from 'react';
import uPlot, { Axis, Padding } from 'uplot';

import {
  CompactTimeSeriesData,
  FieldConfigOptionsRegistry,
  FieldConfigPropertyItem,
  FieldConfigSource,
  FieldType,
  identityOverrideProcessor,
  PanelProps,
  useDataLinksContext,
} from '@grafana/data';
import { getPluginImportUtils } from '@grafana/runtime';
import { AxisPlacement, GraphFieldConfig, TooltipDisplayMode, VisibilityMode, VizOrientation } from '@grafana/schema';
import { measureText, UPLOT_AXIS_FONT_SIZE, useTheme2 } from '@grafana/ui';
import { TimeSeries } from 'app/core/components/TimeSeries/TimeSeries';
import {
  buildCompactStandaloneBarFieldConfig,
  isCompactStandaloneBarChartConfigurationSupported,
} from 'app/features/query/state/compactQueryPolicy';

import { CompactTooltipPlugin } from '../timeseries/CompactTooltipPlugin';

import { Options } from './panelcfg.gen';

const COMPACT_GRAPH_PROPERTIES = [
  'barAlignment',
  'barMaxWidth',
  'barWidthFactor',
  'drawStyle',
  'showPoints',
  'showValues',
  'stacking',
] as const;

const CompactFieldConfigEditor = () => null;

export function getRenderableCompactBarSeries(
  compactSeries: CompactTimeSeriesData | undefined,
  fieldConfig: FieldConfigSource,
  options: Options,
  hasFullFormatRequest = false
): CompactTimeSeriesData | undefined {
  return compactSeries &&
    !hasFullFormatRequest &&
    isCompactStandaloneBarChartConfigurationSupported({
      fieldConfig,
      legendCalcs: Array.isArray(options.legend?.calcs) ? options.legend.calcs : undefined,
      panelOptions: options,
    })
    ? compactSeries
    : undefined;
}

export function buildCompactBarFieldConfig(
  fieldConfig: FieldConfigSource,
  options: Options
): FieldConfigSource<GraphFieldConfig> {
  return buildCompactStandaloneBarFieldConfig(fieldConfig, options);
}

export function CompactBarChart(props: PanelProps<Options> & { compactSeries: CompactTimeSeriesData }) {
  const { compactSeries, data, fieldConfig, options, timeRange, timeZone, width, height, replaceVariables } = props;
  const theme = useTheme2();
  const { dataLinkPostProcessor } = useDataLinksContext();
  const resolvedOrientation =
    options.orientation === VizOrientation.Auto
      ? width < height
        ? VizOrientation.Horizontal
        : VizOrientation.Vertical
      : options.orientation;
  const compactOrientation =
    resolvedOrientation === VizOrientation.Horizontal ? VizOrientation.Vertical : VizOrientation.Horizontal;
  const fieldConfigRegistry = useMemo(createCompactBarFieldConfigRegistry, []);
  const adaptedFieldConfig = useMemo(() => buildCompactBarFieldConfig(fieldConfig, options), [fieldConfig, options]);
  const compactFieldConfig = useMemo(() => {
    return {
      fieldConfig: adaptedFieldConfig,
      fieldConfigRegistry,
      replaceVariables,
      theme,
      timeZone,
      dataLinkPostProcessor,
      cursorMode: options.tooltip.mode,
      highlightSeriesOnHover: options.fullHighlight !== false,
      capability: 'standalone-barchart' as const,
      barOptions: {
        mode: 'grouped' as const,
        groupWidth: options.groupWidth,
        barWidth: options.barWidth,
        barRadius: options.barRadius,
        showValue:
          options.showValue === VisibilityMode.Always
            ? ('always' as const)
            : options.showValue === VisibilityMode.Never
              ? ('never' as const)
              : ('auto' as const),
        valueSize: options.text?.valueSize,
        fullHighlight: options.fullHighlight,
      },
    };
  }, [adaptedFieldConfig, dataLinkPostProcessor, fieldConfigRegistry, options, replaceVariables, theme, timeZone]);
  const compactOptions = useMemo(() => {
    const categoriesAreHorizontal = compactOrientation === VizOrientation.Horizontal;
    const tickLabelRotation = -(options.xTickLabelRotation ?? 0);
    const tickFilter = createCompactTickFilter(options.xTickLabelSpacing ?? 0);
    return {
      orientation: compactOrientation,
      tooltip: options.tooltip,
      highlightSeriesOnHover: options.fullHighlight !== false,
      compactPadding: createCompactRotationPadding(options.xTickLabelRotation ?? 0),
      compactXAxisConfig: {
        // Default axis labels apply only to numeric fields; category-label overrides use the full renderer.
        show: adaptedFieldConfig.defaults.custom?.axisPlacement !== AxisPlacement.Hidden,
        gap: 15,
        grid: { show: false },
        ticks: { show: false },
        tickLabelRotation: categoriesAreHorizontal ? tickLabelRotation : 0,
        filter: categoriesAreHorizontal ? tickFilter : undefined,
      },
      compactValueAxisConfig: categoriesAreHorizontal ? undefined : { tickLabelRotation, filter: tickFilter },
    };
  }, [
    adaptedFieldConfig.defaults.custom?.axisPlacement,
    compactOrientation,
    options.fullHighlight,
    options.tooltip,
    options.xTickLabelRotation,
    options.xTickLabelSpacing,
  ]);

  return (
    <TimeSeries
      frames={[]}
      compactSeries={compactSeries}
      compactFieldConfig={compactFieldConfig}
      structureRev={data.structureRev}
      timeRange={timeRange}
      timeZone={timeZone}
      width={width}
      height={height}
      legend={options.legend}
      options={compactOptions}
      replaceVariables={replaceVariables}
      dataLinkPostProcessor={dataLinkPostProcessor}
      compactChildren={(uplotConfig, plan) =>
        options.tooltip.mode === TooltipDisplayMode.None ? null : (
          <CompactTooltipPlugin
            config={uplotConfig}
            plan={plan}
            mode={options.tooltip.mode}
            sortOrder={options.tooltip.sort}
            hideZeros={options.tooltip.hideZeros}
            maxHeight={options.tooltip.maxHeight}
            maxWidth={options.tooltip.maxWidth}
            timeZone={timeZone}
          />
        )
      }
    />
  );
}

export function createCompactRotationPadding(rotation: number): Padding | undefined {
  if (rotation === 0) {
    return undefined;
  }
  const radians = (Math.abs(rotation) * Math.PI) / 180;
  const labelWidth = measureText('00:00:00.000', UPLOT_AXIS_FONT_SIZE).width;
  const edgePadding = Math.ceil(Math.cos(radians) * labelWidth);
  const bottomPadding = Math.ceil(Math.sin(radians) * labelWidth);
  return [UPLOT_AXIS_FONT_SIZE, rotation > 0 ? edgePadding : 0, bottomPadding, rotation < 0 ? edgePadding : 0];
}

function createCompactBarFieldConfigRegistry(): FieldConfigOptionsRegistry {
  const plugin = getPluginImportUtils().getPanelPluginFromCache('barchart');
  if (!plugin) {
    throw new Error('Bar chart panel plugin is not loaded');
  }
  const baseItems = plugin.fieldConfigRegistry.list();
  const registeredIds = new Set(baseItems.map((item) => item.id));
  return new FieldConfigOptionsRegistry(() => [
    ...baseItems,
    ...COMPACT_GRAPH_PROPERTIES.filter((path) => !registeredIds.has(`custom.${path}`)).map(createGraphProperty),
  ]);
}

function createGraphProperty(path: (typeof COMPACT_GRAPH_PROPERTIES)[number]): FieldConfigPropertyItem {
  return {
    id: `custom.${path}`,
    path,
    name: path,
    isCustom: true,
    editor: CompactFieldConfigEditor,
    override: CompactFieldConfigEditor,
    process: identityOverrideProcessor,
    shouldApply: (field) => field.type === FieldType.number,
  };
}

function createCompactTickFilter(spacing: number): Axis.Filter | undefined {
  if (spacing === 0) {
    return undefined;
  }
  return (plot, splits, axisIndex) => {
    const scale = plot.scales[plot.axes[axisIndex].scale ?? 'x'];
    const dimension = (scale.ori === 1 ? plot.bbox.height : plot.bbox.width) / uPlot.pxRatio;
    const maxTicks = Math.max(1, Math.floor(dimension / Math.abs(spacing)));
    const skip = splits.length <= maxTicks ? 1 : Math.ceil(splits.length / maxTicks);
    const last = splits.length - 1;
    return splits.map((value, index) => {
      const anchoredIndex = spacing > 0 ? index : last - index;
      return anchoredIndex % skip === 0 ? value : null;
    });
  };
}
