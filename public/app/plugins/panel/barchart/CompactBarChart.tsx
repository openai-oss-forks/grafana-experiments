import { useMemo } from 'react';
import uPlot, { Axis, Padding } from 'uplot';

import {
  CompactTimeSeriesData,
  FieldConfigOptionsRegistry,
  FieldConfigPropertyItem,
  FieldConfigSource,
  FieldType,
  identityOverrideProcessor,
  LoadingState,
  PanelProps,
  useDataLinksContext,
} from '@grafana/data';
import { getPluginImportUtils } from '@grafana/runtime';
import { AxisPlacement, GraphFieldConfig, VisibilityMode, VizOrientation } from '@grafana/schema';
import { measureText, UPLOT_AXIS_FONT_SIZE, useTheme2 } from '@grafana/ui';
import type { CompactRenderController } from '@grafana/ui/internal';
import { TimeSeries } from 'app/core/components/TimeSeries/TimeSeries';
import { formatCompactBarTimeTicks } from 'app/core/components/TimeSeries/utils';
import {
  buildCompactStandaloneBarFieldConfig,
  isCompactStandaloneBarChartConfigurationSupported,
} from 'app/features/query/state/compactQueryPolicy';

import { CompactTooltipPlugin } from '../timeseries/CompactTooltipPlugin';

import { Options } from './panelcfg.gen';
import { calculateBarChartRotationPadding } from './utils';

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
const COMPACT_BAR_CHAR_WIDTH = measureText('M', UPLOT_AXIS_FONT_SIZE).width;
const TO_RADIANS = Math.PI / 180;

export function getRenderableCompactBarSeries(
  compactSeries: CompactTimeSeriesData | undefined,
  fieldConfig: FieldConfigSource,
  options: Options,
  hasFullFormatRequest = false
): CompactTimeSeriesData | undefined {
  return compactSeries &&
    compactSeries.series.length > 0 &&
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
  const {
    compactSeries,
    data,
    fieldConfig,
    options,
    timeRange,
    timeZone,
    width,
    height,
    replaceVariables,
    onChangeTimeRange,
  } = props;
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
    const configuredRotation = options.xTickLabelRotation ?? 0;
    const tickLabelRotation = configuredRotation === 0 ? 0 : -configuredRotation;
    const tickLabelSpacing = options.xTickLabelSpacing ?? 0;
    const tickLabelMaxLength = resolveCompactBarTickLabelMaxLength(
      options.xTickLabelMaxLength,
      configuredRotation,
      height
    );
    return {
      orientation: compactOrientation,
      tooltip: options.tooltip,
      highlightSeriesOnHover: options.fullHighlight !== false,
      compactGroupedBarTickSpacing: categoriesAreHorizontal ? tickLabelSpacing : 0,
      compactPadding: (controller: CompactRenderController) =>
        createCompactRotationPadding(configuredRotation, categoriesAreHorizontal, () => ({
          labels: getCompactBarRotationLabels(controller, timeZone, tickLabelMaxLength),
          revision: controller.groupedBarRevision(),
        })),
      compactXAxisConfig: {
        show: adaptedFieldConfig.defaults.custom?.axisPlacement !== AxisPlacement.Hidden,
        label: adaptedFieldConfig.defaults.custom?.axisLabel,
        gap: 15,
        grid: { show: false },
        ticks: { show: false },
        tickLabelRotation: categoriesAreHorizontal ? tickLabelRotation : 0,
      },
      compactValueAxisConfig: categoriesAreHorizontal
        ? undefined
        : { tickLabelRotation, filter: createCompactTickFilter(tickLabelSpacing) },
    };
  }, [
    adaptedFieldConfig.defaults.custom?.axisPlacement,
    adaptedFieldConfig.defaults.custom?.axisLabel,
    compactOrientation,
    height,
    options.fullHighlight,
    options.tooltip,
    options.xTickLabelMaxLength,
    options.xTickLabelRotation,
    options.xTickLabelSpacing,
    timeZone,
  ]);

  return (
    <TimeSeries
      frames={[]}
      compactSeries={compactSeries}
      compactFieldConfig={compactFieldConfig}
      compactStreaming={data.state === LoadingState.Streaming}
      compactRequestKey={data.request?.requestId}
      structureRev={data.structureRev}
      timeRange={timeRange}
      timeZone={timeZone}
      width={width}
      height={height}
      legend={options.legend}
      options={compactOptions}
      replaceVariables={replaceVariables}
      dataLinkPostProcessor={dataLinkPostProcessor}
      compactChildren={(uplotConfig, plan) => (
        <CompactTooltipPlugin
          config={uplotConfig}
          plan={plan}
          mode={options.tooltip.mode}
          sortOrder={options.tooltip.sort}
          hideZeros={options.tooltip.hideZeros}
          maxHeight={options.tooltip.maxHeight}
          maxWidth={options.tooltip.maxWidth}
          timeZone={timeZone}
          queryZoom={onChangeTimeRange}
        />
      )}
    />
  );
}

export function resolveCompactBarTickLabelMaxLength(
  configuredMaximum: number | undefined,
  rotation: number,
  height: number
): number {
  return rotation === 0
    ? Number.POSITIVE_INFINITY
    : configuredMaximum ||
        Math.floor(height / 2 / Math.sin(Math.abs(rotation * TO_RADIANS)) / COMPACT_BAR_CHAR_WIDTH - 3);
}

export function createCompactRotationPadding(
  rotation: number,
  categoriesAreHorizontal = true,
  labels: readonly string[] | (() => { labels: readonly string[]; revision: number }) = ['00:00:00.000']
): Padding | undefined {
  if (rotation === 0) {
    return undefined;
  }
  if (typeof labels === 'function') {
    let cachedRevision = -1;
    let cachedPadding = calculateBarChartRotationPadding([], rotation, 50, categoriesAreHorizontal ? 14 : 5);
    const resolvePadding = () => {
      const current = labels();
      if (current.revision !== cachedRevision) {
        cachedRevision = current.revision;
        cachedPadding = calculateBarChartRotationPadding(
          current.labels,
          rotation,
          50,
          categoriesAreHorizontal ? 14 : 5
        );
      }
      return cachedPadding;
    };
    return [
      Math.round(UPLOT_AXIS_FONT_SIZE * uPlot.pxRatio),
      () => resolvePadding()[1],
      () => resolvePadding()[2],
      () => resolvePadding()[3],
    ];
  }
  return calculateBarChartRotationPadding(labels, rotation, 50, categoriesAreHorizontal ? 14 : 5);
}

function getCompactBarRotationLabels(
  controller: CompactRenderController,
  timeZone: string,
  maximumLength: number
): string[] {
  return formatCompactBarTimeTicks(controller.groupedBarTimestampSamples(), timeZone, controller.groupedBarIncrement())
    .filter((label): label is string => label != null)
    .map((label) =>
      Number.isFinite(maximumLength) && label.length > maximumLength ? `${label.substring(0, maximumLength)}...` : label
    );
}

export function createCompactTickFilter(spacing: number): Axis.Filter | undefined {
  if (spacing === 0) {
    return undefined;
  }
  return (plot, splits, axisIndex) => {
    const scale = plot.scales[plot.axes[axisIndex].scale ?? 'x'];
    const maximumCount = Math.max(1, Math.abs(Math.floor(plot.bbox.width / uPlot.pxRatio / spacing)));
    const skip = splits.length <= maximumCount ? 1 : Math.ceil(splits.length / maximumCount);
    const last = splits.length - 1;
    const filtered = splits.map((value, index) => {
      const anchoredIndex = spacing > 0 ? index : last - index;
      return anchoredIndex % skip === 0 ? value : null;
    });
    const direction = (scale.dir ?? 1) * (scale.ori === 1 ? -1 : 1);
    return direction === 1 ? filtered : filtered.reverse();
  };
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
