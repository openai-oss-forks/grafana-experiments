import { cloneDeep, isEqual } from 'lodash';

import {
  colorManipulator,
  CompactTimeSeriesData,
  CompactTimeSeriesSeriesCollection,
  DisplayProcessor,
  FieldConfig,
  FieldConfigTarget,
  FieldMatcherID,
  FieldOverrideEnv,
  FieldType,
  getFieldColorCalculator,
  getFieldColorMode,
  getDisplayProcessor,
  getScaleCalculator,
  formattedValueToString,
  isCompactTimeSeriesReducerSupported,
  isCompactTimeSeriesSeriesCollection,
  Labels,
  NullValueMode,
  NumericRange,
  ReducerID,
  setDynamicConfigValue,
  setFieldConfigDefaults,
  stringToJsRegex,
  TIME_SERIES_VALUE_FIELD_NAME,
} from '@grafana/data';
import { compareValues } from '@grafana/data/internal';
import {
  AxisColorMode,
  GraphDrawStyle,
  GraphFieldConfig,
  GraphGradientMode,
  GraphTransform,
  HideSeriesConfig,
  LineInterpolation,
  ScaleDistribution,
  StackingMode,
  VisibilityMode,
} from '@grafana/schema';
import {
  buildScaleKey,
  CompactRenderSource,
  CompactScaleRecord,
  CompactSeriesFlag,
  CompactStyleRecord,
  CompactVisibilityState,
  hasCompatibleCompactRenderSource,
  isCompactRenderSource,
} from '@grafana/ui/internal';

import {
  assertCompactFieldConfig,
  canonicalizeCompactCustomConfig,
  normalizeCompactFillOpacity,
  normalizeCompactInsertNulls,
  normalizeCompactLineStyle,
  parseCompactValueMatcher,
  type CompactValueMatcher,
} from './compactCapabilities';
import { CompactIndexColumn, CompactIndexColumnBuilder } from './compactColumns';
import { CompactPlotSource, CompactPlotSeriesOptions, createCompactPlotSource } from './compactPlotSource';
import type { CompactFieldConfigOptions } from './compactTypes';

const NO_STRING_ID = 0;
const REDUCTION_UNSET = 0;
const REDUCTION_NUMBER = 1;
const REDUCTION_NULL = 2;
const REDUCTION_UNDEFINED = 3;
const REDUCTION_FALSE = 4;
const REDUCTION_TRUE = 5;
const LAZY_CACHE_CHUNK_SIZE = 4096;

const scaleCustomProperties = new Set<keyof GraphFieldConfig>([
  'axisBorderShow',
  'axisCenteredZero',
  'axisColorMode',
  'axisGridShow',
  'axisLabel',
  'axisPlacement',
  'axisSoftMax',
  'axisSoftMin',
  'axisWidth',
  'scaleDistribution',
  'thresholdsStyle',
]);

const reducerValues = Object.values(ReducerID);
const reducerIds = new Set<string>(reducerValues);
const visibilityStates = new WeakMap<CompactTimeSeriesData, CompactVisibilityState>();

export const enum CompactNativeSeriesFlag {
  HasGaps = 1 << 0,
  HiddenFromViz = 1 << 1,
  HiddenFromLegend = 1 << 2,
  HiddenFromTooltip = 1 << 3,
  NegativeY = 1 << 4,
  Constant = 1 << 5,
}

export interface CompactNativePlanColumns {
  readonly configIds: CompactIndexColumn;
  readonly flags: Uint8Array;
  readonly configuredDisplayNameIds: CompactIndexColumn;
}

export interface CompactNativeStyleRecord {
  readonly config: Readonly<FieldConfig<GraphFieldConfig>>;
}

export interface CompactNativeScaleRecord {
  readonly config: Readonly<FieldConfig<GraphFieldConfig>>;
}

export interface CompactNativeRenderPlan {
  readonly kind: 'compact-native-render-plan';
  readonly data: CompactTimeSeriesData;
  readonly source: CompactRenderSource;
  readonly columns: CompactNativePlanColumns;
  readonly styles: readonly CompactNativeStyleRecord[];
  readonly scales: readonly CompactNativeScaleRecord[];
  readonly seriesCount: number;
  getStyle(seriesIndex: number): CompactNativeStyleRecord;
  getScale(seriesIndex: number): CompactNativeScaleRecord;
  getDisplayName(seriesIndex: number): string;
  getLabels(seriesIndex: number): Labels | undefined;
  getDisplay(seriesIndex: number): DisplayProcessor;
  reduce(seriesIndex: number, reducer: ReducerID): unknown;
}

interface ReductionCache {
  readonly chunks: Map<number, ReductionCacheChunk>;
}

interface ReductionCacheChunk {
  readonly states: Uint8Array;
  readonly values: Float64Array;
}

interface MedianMatcherMemo {
  seriesIndex: number;
  readonly cache: ReductionCacheChunk;
}

interface RangeCacheChunk {
  readonly states: Uint8Array;
  readonly mins: Float64Array;
  readonly maxs: Float64Array;
}

interface NumericRangeCacheEntry<T> {
  readonly configId: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly value: T;
}

type NumericRangeValueCache<T> = Map<number, Array<NumericRangeCacheEntry<T>>>;

interface CompiledConfigRecord {
  readonly config: FieldConfig<GraphFieldConfig>;
  readonly styleId: number;
  readonly scaleId: number;
}

interface RendererConfigRecord {
  readonly config: FieldConfig<GraphFieldConfig>;
  readonly custom: GraphFieldConfig;
  readonly colorMode: ReturnType<typeof getFieldColorMode>;
  readonly drawStyle: GraphDrawStyle;
  readonly lineWidth: number;
  readonly pointSize: number;
  readonly pointSpace: number;
  readonly pointLineWidth: number;
  readonly fillAlpha: number;
  readonly gradientMode: GraphGradientMode;
  readonly lineDash: readonly number[];
  readonly lineCap: 'butt' | 'round';
  readonly disconnectThreshold: number | undefined;
  readonly spanNullsThreshold: number | undefined;
  readonly showValues: boolean;
  readonly showPoints: VisibilityMode | undefined;
  readonly stackingMode: StackingMode;
  readonly stackingGroup: string;
  readonly barAlignment: -1 | 0 | 1;
  readonly barWidthFactor: number;
  readonly barMaxWidth: number;
}

interface RendererStackGroupRecord {
  readonly direction: 1 | -1;
  readonly group: string;
  readonly scaleId: number;
  readonly drawStyle: GraphDrawStyle;
  readonly path: CompactSeriesFlag;
  readonly mode: StackingMode;
}

interface LabelProfile {
  singleLabelName: string | null;
}

interface CompactSeriesAccess {
  getAxisId(index: number): number;
  getRefId(index: number): string;
  getFrameName(index: number): string | undefined;
  getValueName(index: number): string;
  getDisplayNameFromDS(index: number): string | undefined;
  getLabelCount(index: number): number;
  getLabel(index: number, name: string): string | undefined;
  forEachLabel(index: number, callback: (name: string, value: string) => void): void;
  getSharedLabelName(): string | null;
  getIdentityHash(index: number): number;
  getPresenceByteOffset(index: number): number;
  getPresenceByteLength(index: number): number;
  getPresentCount(index: number): number;
  getValuesByteOffset(index: number): number;
}

export function createCompactNativeRenderPlan(
  data: CompactTimeSeriesData,
  options: CompactFieldConfigOptions
): CompactNativeRenderPlan {
  assertCompactFieldConfig(options.fieldConfig, options.capability);
  const seriesCount = data.series.length;
  const access = createSeriesAccess(data);
  const configIdBuilder = new CompactIndexColumnBuilder(seriesCount);
  const flags = new Uint8Array(seriesCount);
  const barLayoutVisibility = new Uint8Array(seriesCount);
  const configuredDisplayNameIdBuilder = new CompactIndexColumnBuilder(seriesCount);
  const compiledConfigs: CompiledConfigRecord[] = [];
  const compiledConfigBuckets = new Map<number, number[]>();
  const styles: CompactNativeStyleRecord[] = [];
  const scales: CompactNativeScaleRecord[] = [];
  const styleBuckets = new Map<number, number[]>();
  const scaleBuckets = new Map<number, number[]>();
  const configuredDisplayNames: string[] = [];
  const configuredDisplayNameKeys = new Map<string, number>();
  const dataView = new DataView(data.buffer);
  const dataBytes = new Uint8Array(data.buffer);
  const medianWorkspace = new CompactMedianWorkspace();
  const medianMatcherMemo: MedianMatcherMemo = {
    seriesIndex: -1,
    cache: {
      states: new Uint8Array(3),
      values: new Float64Array(3),
    },
  };
  let visibilityState = visibilityStates.get(data);
  if (!visibilityState) {
    visibilityState = { overrides: new Map() };
    visibilityStates.set(data, visibilityState);
  }
  let frameNamesDiffer: boolean | undefined;
  const getFrameNamesDiffer = () => (frameNamesDiffer ??= calculateFrameNamesDiffer(access, seriesCount));
  let labelProfile: LabelProfile | undefined;

  const getLabelProfile = () => {
    if (!labelProfile) {
      labelProfile = calculateLabelProfile(access, seriesCount);
    }
    return labelProfile;
  };

  let currentSeriesIndex = 0;
  const scratchConfig: FieldConfig<GraphFieldConfig> = {};
  const scratch: FieldConfigTarget<GraphFieldConfig> = {
    get name() {
      return getFieldName(access, currentSeriesIndex);
    },
    type: FieldType.number,
    config: scratchConfig,
  };
  const context: FieldOverrideEnv = {
    target: scratch,
    data: [],
    dataFrameIndex: 0,
    replaceVariables: (value, scopedVars, format) =>
      options.replaceVariables(
        replaceCompactVariables(
          value,
          currentSeriesIndex,
          scratch.config,
          access,
          getFrameNamesDiffer(),
          getLabelProfile
        ),
        scopedVars,
        format
      ),
    fieldConfigRegistry: options.fieldConfigRegistry,
  };
  const compiledValueMatchers = options.fieldConfig.overrides.map((rule) =>
    rule.matcher.id === FieldMatcherID.byValue ? parseCompactValueMatcher(rule.matcher.options) : undefined
  );

  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
    currentSeriesIndex = seriesIndex;
    scratch.type = FieldType.number;
    clearRecord(scratchConfig);
    scratch.state = undefined;
    scratch.display = undefined;
    scratch.labels = undefined;
    context.dataFrameIndex = seriesIndex;
    const configuredHideFrom: HideSeriesConfig = {
      legend: false,
      tooltip: false,
      viz: false,
      ...options.fieldConfig.defaults.custom?.hideFrom,
    };

    setFieldConfigDefaults(scratch.config, options.fieldConfig.defaults, context);
    for (let ruleIndex = 0; ruleIndex < options.fieldConfig.overrides.length; ruleIndex++) {
      const rule = options.fieldConfig.overrides[ruleIndex];
      if (
        !matchesSeries(
          rule.matcher.id,
          rule.matcher.options,
          compiledValueMatchers[ruleIndex],
          seriesIndex,
          scratch.config,
          data,
          dataView,
          dataBytes,
          access,
          getFrameNamesDiffer,
          getLabelProfile,
          medianWorkspace,
          medianMatcherMemo
        )
      ) {
        continue;
      }
      if (!('__systemRef' in rule)) {
        for (const property of rule.properties) {
          if (property.id === 'custom.hideFrom' && typeof property.value === 'object' && property.value !== null) {
            Object.assign(configuredHideFrom, property.value);
          }
        }
      }
      for (const property of rule.properties) {
        setDynamicConfigValue(scratch.config, property, context);
      }
    }

    scratch.config.custom = canonicalizeCompactCustomConfig(scratch.config.custom, options.capability);

    const configuredDisplayNameId = internOptionalString(
      scratchConfig.displayName,
      configuredDisplayNames,
      configuredDisplayNameKeys
    );
    configuredDisplayNameIdBuilder.set(seriesIndex, configuredDisplayNameId);
    flags[seriesIndex] = calculateFlags(
      scratchConfig,
      configuredHideFrom,
      access.getPresenceByteLength(seriesIndex),
      options.capability
    );
    barLayoutVisibility[seriesIndex] = configuredHideFrom.viz ? 0 : 1;

    const configId = internCompiledConfig(
      scratchConfig,
      compiledConfigs,
      compiledConfigBuckets,
      styles,
      styleBuckets,
      scales,
      scaleBuckets
    );
    configIdBuilder.set(seriesIndex, configId);
  }

  const configIds = configIdBuilder.finish();
  const configuredDisplayNameIds = configuredDisplayNameIdBuilder.finish();

  const reusablePlotOptions: CompactPlotSeriesOptions = {};
  const plotSource = createCompactPlotSource(data, (seriesIndex) => {
    const config = styles[compiledConfigs[configIds[seriesIndex]].styleId].config;
    reusablePlotOptions.noValue = options.capability === 'standalone-barchart' ? undefined : config.noValue;
    reusablePlotOptions.transform = config.custom?.transform;
    reusablePlotOptions.spanNulls = config.custom?.spanNulls;
    reusablePlotOptions.insertNulls = config.custom?.insertNulls;
    return reusablePlotOptions;
  });
  const reductionCaches = new Map<ReducerID, ReductionCache>();
  const renderedMinMaxCache = new Map<number, RangeCacheChunk>();
  const sourceMinMaxCache = new Map<number, RangeCacheChunk>();
  const rangeCache = new Map<number, RangeCacheChunk>();
  let globalRange: NumericRange | undefined;
  const displayCache: NumericRangeValueCache<DisplayProcessor> = new Map();

  const getConfigRecord = (seriesIndex: number) =>
    compiledConfigs[configIds[assertSeriesIndex(seriesIndex, seriesCount)]];
  const getStyle = (seriesIndex: number) => styles[getConfigRecord(seriesIndex).styleId];
  const getScale = (seriesIndex: number) => scales[getConfigRecord(seriesIndex).scaleId];
  const getMergedConfig = (seriesIndex: number): FieldConfig<GraphFieldConfig> => getConfigRecord(seriesIndex).config;

  const getRenderedSeriesMinMax = (seriesIndex: number): NumericRange => {
    const cache = getRangeCacheChunk(renderedMinMaxCache, seriesIndex);
    const chunkIndex = seriesIndex % LAZY_CACHE_CHUNK_SIZE;
    if (cache.states[chunkIndex] === 0) {
      const { min, max } = calculateCompactMinMax(
        data,
        dataView,
        dataBytes,
        access,
        seriesIndex,
        getStyle(seriesIndex).config
      );
      cache.mins[chunkIndex] = min ?? Number.NaN;
      cache.maxs[chunkIndex] = max ?? Number.NaN;
      cache.states[chunkIndex] = 1;
    }
    const min = Number.isNaN(cache.mins[chunkIndex]) ? null : cache.mins[chunkIndex];
    const max = Number.isNaN(cache.maxs[chunkIndex]) ? null : cache.maxs[chunkIndex];
    return { min, max, delta: (max ?? 0) - (min ?? 0) };
  };

  const getSourceSeriesMinMax = (seriesIndex: number): NumericRange => {
    const cache = getRangeCacheChunk(sourceMinMaxCache, seriesIndex);
    const chunkIndex = seriesIndex % LAZY_CACHE_CHUNK_SIZE;
    if (cache.states[chunkIndex] === 0) {
      const { min, max } = calculateCompactSourceMinMax(dataView, access, seriesIndex, getStyle(seriesIndex).config);
      cache.mins[chunkIndex] = min ?? Number.NaN;
      cache.maxs[chunkIndex] = max ?? Number.NaN;
      cache.states[chunkIndex] = 1;
    }
    const min = Number.isNaN(cache.mins[chunkIndex]) ? null : cache.mins[chunkIndex];
    const max = Number.isNaN(cache.maxs[chunkIndex]) ? null : cache.maxs[chunkIndex];
    return { min, max, delta: (max ?? 0) - (min ?? 0) };
  };

  const reduce = (seriesIndex: number, reducer: ReducerID): unknown => {
    assertSeriesIndex(seriesIndex, seriesCount);
    if (!isCompactTimeSeriesReducerSupported(reducer)) {
      throw new Error(`Compact native reducer ${reducer} is unsupported`);
    }
    if (reducer === ReducerID.min || reducer === ReducerID.max) {
      return getRenderedSeriesMinMax(seriesIndex)[reducer];
    }
    let cache = reductionCaches.get(reducer);
    if (!cache) {
      cache = { chunks: new Map() };
      reductionCaches.set(reducer, cache);
    }
    const cacheChunk = getReductionCacheChunk(cache, seriesIndex);
    const chunkIndex = seriesIndex % LAZY_CACHE_CHUNK_SIZE;
    if (cacheChunk.states[chunkIndex] === REDUCTION_UNSET) {
      const value = reduceCompactSeries(
        data,
        dataView,
        dataBytes,
        access,
        seriesIndex,
        getStyle(seriesIndex).config,
        reducer,
        medianWorkspace
      );
      writeReduction(cacheChunk, chunkIndex, value);
    }
    return readReduction(cacheChunk, chunkIndex);
  };

  const getDisplayName = (seriesIndex: number): string => {
    assertSeriesIndex(seriesIndex, seriesCount);
    const configuredId = configuredDisplayNameIds[seriesIndex];
    if (configuredId !== NO_STRING_ID) {
      return configuredDisplayNames[configuredId - 1];
    }
    const displayNameFromDS = access.getDisplayNameFromDS(seriesIndex);
    if (displayNameFromDS) {
      return displayNameFromDS;
    }
    return calculateDisplayName(
      seriesIndex,
      getStyle(seriesIndex).config,
      access,
      getFrameNamesDiffer(),
      getLabelProfile()
    );
  };

  const getLabels = (seriesIndex: number): Labels | undefined => {
    assertSeriesIndex(seriesIndex, seriesCount);
    let labels: Labels | undefined;
    access.forEachLabel(seriesIndex, (name, value) => {
      (labels ??= {})[name] = value;
    });
    if (frameNameShouldBeLabel(access, seriesIndex)) {
      (labels ??= {}).name = access.getFrameName(seriesIndex)!;
    }
    return labels;
  };

  const getSeriesIdentity = (seriesIndex: number): string => {
    assertSeriesIndex(seriesIndex, seriesCount);
    const labels: Array<[string, string]> = [];
    access.forEachLabel(seriesIndex, (name, value) => labels.push([name, value]));
    labels.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return JSON.stringify([
      access.getRefId(seriesIndex),
      access.getFrameName(seriesIndex),
      access.getValueName(seriesIndex),
      access.getDisplayNameFromDS(seriesIndex),
      labels,
    ]);
  };
  const getSeriesIdentityHash = (seriesIndex: number): number => {
    assertSeriesIndex(seriesIndex, seriesCount);
    return access.getIdentityHash(seriesIndex);
  };

  const getGlobalRange = (): NumericRange => {
    if (globalRange) {
      return globalRange;
    }
    let min: number | null = null;
    let max: number | null = null;
    for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
      const { min: seriesMin, max: seriesMax } = getSourceSeriesMinMax(seriesIndex);
      if (seriesMin != null && (min == null || seriesMin < min)) {
        min = seriesMin;
      }
      if (seriesMax != null && (max == null || seriesMax > max)) {
        max = seriesMax;
      }
    }
    globalRange = { min, max, delta: (max ?? 0) - (min ?? 0) };
    return globalRange;
  };

  const getRange = (seriesIndex: number): NumericRange => {
    const cache = getRangeCacheChunk(rangeCache, seriesIndex);
    const chunkIndex = seriesIndex % LAZY_CACHE_CHUNK_SIZE;
    if (cache.states[chunkIndex] === 0) {
      const scale = getScale(seriesIndex).config;
      const base =
        scale.min != null && scale.max != null
          ? { min: scale.min, max: scale.max }
          : scale.fieldMinMax
            ? getSourceSeriesMinMax(seriesIndex)
            : getGlobalRange();
      const min = scale.min ?? base.min;
      const max = scale.max ?? base.max;
      cache.mins[chunkIndex] = min ?? Number.NaN;
      cache.maxs[chunkIndex] = max ?? Number.NaN;
      cache.states[chunkIndex] = 1;
    }
    const min = Number.isNaN(cache.mins[chunkIndex]) ? null : cache.mins[chunkIndex];
    const max = Number.isNaN(cache.maxs[chunkIndex]) ? null : cache.maxs[chunkIndex];
    return { min, max, delta: (max ?? 0) - (min ?? 0) };
  };

  const getDisplay = (seriesIndex: number): DisplayProcessor => {
    assertSeriesIndex(seriesIndex, seriesCount);
    const range = getRange(seriesIndex);
    const configId = configIds[seriesIndex];
    const rangeMin = range.min ?? null;
    const rangeMax = range.max ?? null;
    return getNumericRangeCacheValue(displayCache, configId, rangeMin, rangeMax, () => {
      const config = getMergedConfig(seriesIndex);
      return getDisplayProcessor({
        field: {
          name: TIME_SERIES_VALUE_FIELD_NAME,
          type: FieldType.number,
          config,
          state: { range },
        },
        theme: options.theme,
        timeZone: options.timeZone,
      });
    });
  };

  const source = createRenderSource(
    plotSource,
    seriesCount,
    (seriesIndex) => configIds[assertSeriesIndex(seriesIndex, seriesCount)],
    (seriesIndex) => getConfigRecord(seriesIndex).styleId,
    getScale,
    getMergedConfig,
    getDisplayName,
    getRange,
    reduce,
    getSeriesIdentity,
    getSeriesIdentityHash,
    visibilityState,
    barLayoutVisibility,
    getDisplay,
    options
  );

  return {
    kind: 'compact-native-render-plan',
    data,
    source,
    columns: { configIds, flags, configuredDisplayNameIds },
    styles,
    scales,
    seriesCount,
    getStyle,
    getScale,
    getDisplayName,
    getLabels,
    getDisplay,
    reduce,
  };
}

export function hasSameCompactNativeTopology(
  left: CompactNativeRenderPlan | undefined,
  right: CompactNativeRenderPlan | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.source.stackGroupCount !== right.source.stackGroupCount) {
    return false;
  }
  return (
    compactColumnsEqual(left.source.columns.stackGroupIds, right.source.columns.stackGroupIds) &&
    compactStackFlagsEqual(left.source.columns.flags, right.source.columns.flags) &&
    isEqual(left.source.scales, right.source.scales) &&
    isEqual(left.scales, right.scales)
  );
}

/**
 * Returns whether an existing compact plot configuration can render the next source in place.
 * Virtual series, styles, and normal stack groups are owned by the compact renderer and may grow
 * while a streamed response is in progress. The uPlot configuration only needs to be rebuilt when
 * its axes, scales, percent stacking, or grouped-bar X mode changes.
 */
export function hasCompatibleCompactNativeConfig(
  left: CompactNativeRenderPlan | undefined,
  right: CompactNativeRenderPlan | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return hasCompatibleCompactRenderSource(left.source, right.source) && isEqual(left.scales, right.scales);
}

function createRenderSource(
  source: CompactPlotSource,
  seriesCount: number,
  getConfigId: (seriesIndex: number) => number,
  getStyleConfigId: (seriesIndex: number) => number,
  getScale: (seriesIndex: number) => CompactNativeScaleRecord,
  getConfig: (seriesIndex: number) => FieldConfig<GraphFieldConfig>,
  getDisplayName: (seriesIndex: number) => string,
  getRange: (seriesIndex: number) => NumericRange,
  reduce: (seriesIndex: number, reducer: ReducerID) => unknown,
  getSeriesIdentity: (seriesIndex: number) => string,
  getSeriesIdentityHash: (seriesIndex: number) => number,
  visibilityState: CompactVisibilityState,
  barLayoutVisibility: Uint8Array,
  getDisplay: (seriesIndex: number) => DisplayProcessor,
  options: CompactFieldConfigOptions
): CompactRenderSource {
  const styleIdBuilder = new CompactIndexColumnBuilder(seriesCount);
  const scaleIdBuilder = new CompactIndexColumnBuilder(seriesCount);
  const stackGroupIdBuilder = new CompactIndexColumnBuilder(seriesCount);
  const flags = new Uint16Array(seriesCount);
  const visibility = new Uint8Array(seriesCount);
  const styles: CompactStyleRecord[] = [];
  const scales: CompactScaleRecord[] = [];
  const stackGroups: RendererStackGroupRecord[] = [];
  const stackGroupCounts: number[] = [];
  const stackGroupBuckets = new Map<number, number[]>();
  const rendererStyleIds = new Map<number, Map<string, number>>();
  const scaleBuckets = new Map<number, number[]>();
  const rendererScaleIds = new Map<Readonly<FieldConfig<GraphFieldConfig>>, number>();
  const rendererConfigs = new Map<number, RendererConfigRecord>();
  const colorCalculators = new Map<number, ReturnType<typeof getFieldColorCalculator>>();
  const scaleCalculators: NumericRangeValueCache<ReturnType<typeof getScaleCalculator>> = new Map();
  const percentDisplays = new Map<number, DisplayProcessor>();
  const colorState: { displayName: string; seriesIndex: number; range?: NumericRange } = {
    displayName: '',
    seriesIndex: 0,
  };
  const colorTarget: FieldConfigTarget<GraphFieldConfig> = {
    name: TIME_SERIES_VALUE_FIELD_NAME,
    type: FieldType.number,
    config: {},
    state: colorState,
  };
  let hasValueLabels = false;

  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
    const configId = getConfigId(seriesIndex);
    let rendererConfig = rendererConfigs.get(configId);
    if (!rendererConfig) {
      rendererConfig = compileRendererConfig(getConfig(seriesIndex));
      rendererConfigs.set(configId, rendererConfig);
    }
    const {
      config,
      custom,
      colorMode,
      drawStyle,
      lineWidth,
      pointSize,
      pointSpace,
      pointLineWidth,
      fillAlpha,
      gradientMode,
      lineDash,
      lineCap,
      disconnectThreshold,
      spanNullsThreshold,
      showValues,
      showPoints: configuredShowPoints,
      stackingMode,
      stackingGroup,
      barAlignment,
      barWidthFactor,
      barMaxWidth,
    } = rendererConfig;
    const displayName = colorMode.useSeriesName ? getDisplayName(seriesIndex) : '';
    colorTarget.config = config;
    colorState.displayName = displayName;
    colorState.seriesIndex = seriesIndex;
    colorState.range = colorMode.isByValue ? getRange(seriesIndex) : undefined;
    const calculatedColor = colorMode.isByValue
      ? getCachedScaleCalculator(
          configId,
          colorTarget,
          options,
          scaleCalculators
        )(Number(reduce(seriesIndex, getReducerId(config.color?.seriesBy) ?? ReducerID.last) ?? 0)).color
      : getCachedColorCalculator(configId, colorTarget, options, colorCalculators)(0, 0);
    const lineColor = custom.lineColor ?? calculatedColor;
    hasValueLabels ||= showValues;
    const styleConfigId = getStyleConfigId(seriesIndex);
    let styleIdsByColor = rendererStyleIds.get(styleConfigId);
    if (!styleIdsByColor) {
      styleIdsByColor = new Map();
      rendererStyleIds.set(styleConfigId, styleIdsByColor);
    }
    let rendererStyleId = styleIdsByColor.get(lineColor);
    if (rendererStyleId == null) {
      const areaFill =
        gradientMode === GraphGradientMode.None && fillAlpha > 0
          ? colorManipulator.alpha(lineColor, fillAlpha)
          : undefined;
      const areaGradient =
        gradientMode === GraphGradientMode.Opacity && fillAlpha > 0
          ? ([colorManipulator.alpha(lineColor, fillAlpha), colorManipulator.alpha(lineColor, 0)] as const)
          : undefined;
      rendererStyleId = styles.length;
      styles.push({
        stroke: lineColor,
        cursorStroke: colorManipulator.alpha(lineColor, 0.5),
        fill: lineColor,
        areaFill,
        areaGradient,
        lineWidth,
        pointSize,
        pointSpace,
        pointLineWidth,
        alpha: 1,
        lineDash: [...lineDash],
        lineCap,
        disconnectThreshold,
        spanNullsThreshold,
        showValues,
        barAlignment,
        barWidthFactor,
        barMaxWidth,
      });
      styleIdsByColor.set(lineColor, rendererStyleId);
    }
    styleIdBuilder.set(seriesIndex, rendererStyleId);

    const scaleConfig = getScale(seriesIndex).config;
    let rendererScaleId = rendererScaleIds.get(scaleConfig);
    if (rendererScaleId == null) {
      const scaleKey = buildScaleKey(config, FieldType.number);
      const axisColor =
        custom.axisColorMode === AxisColorMode.Series ? calculatedColor : options.theme.colors.text.primary;
      const scale = createScaleRecord(scaleKey, config, axisColor);
      rendererScaleId = internStructuralRecord(scale, scales, scaleBuckets);
      rendererScaleIds.set(scaleConfig, rendererScaleId);
    }
    scaleIdBuilder.set(seriesIndex, rendererScaleId);

    const pathFlag = getPathFlag(custom.lineInterpolation);
    let seriesFlags = pathFlag;
    if (drawStyle === GraphDrawStyle.Line) {
      seriesFlags |= CompactSeriesFlag.DrawLine;
    } else if (drawStyle === GraphDrawStyle.Bars) {
      seriesFlags |= CompactSeriesFlag.Bars;
    }
    const showPoints = drawStyle === GraphDrawStyle.Points ? VisibilityMode.Always : configuredShowPoints;
    if (showPoints === VisibilityMode.Always) {
      seriesFlags |= CompactSeriesFlag.Points;
    } else if (showPoints === VisibilityMode.Auto && drawStyle !== GraphDrawStyle.Bars) {
      seriesFlags |= CompactSeriesFlag.AutoPoints;
    }
    if (drawStyle === GraphDrawStyle.Bars && custom.transform === GraphTransform.Constant) {
      seriesFlags |= CompactSeriesFlag.Constant;
    }
    if (stackingMode === StackingMode.Normal || stackingMode === StackingMode.Percent) {
      const stackGroupIndex = internStructuralRecord(
        {
          direction: getStackDirection(source, seriesIndex, custom.transform),
          group: stackingGroup,
          scaleId: rendererScaleId,
          drawStyle,
          path: pathFlag,
          mode: stackingMode,
        },
        stackGroups,
        stackGroupBuckets
      );
      stackGroupCounts[stackGroupIndex] = (stackGroupCounts[stackGroupIndex] ?? 0) + 1;
      stackGroupIdBuilder.set(seriesIndex, stackGroupIndex + 1);
      seriesFlags |= CompactSeriesFlag.Stack;
      if (stackingMode === StackingMode.Percent) {
        seriesFlags |= CompactSeriesFlag.PercentStack;
      }
    }
    flags[seriesIndex] = seriesFlags;
    visibility[seriesIndex] = custom.hideFrom?.viz ? 0 : 1;
  }

  const styleIds = styleIdBuilder.finish();
  const scaleIds = scaleIdBuilder.finish();
  const rawStackGroupIds = stackGroupIdBuilder.finish();
  const preserveSingletonStacks =
    options.capability === 'standalone-barchart' && options.barOptions?.mode === 'grouped';
  const { stackGroupIds, stackGroupCount } = compactStackGroups(
    rawStackGroupIds,
    stackGroupCounts,
    flags,
    preserveSingletonStacks
  );
  const stackDirections = new Int8Array(stackGroupCount);
  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
    const compactGroup = stackGroupIds[seriesIndex];
    if (compactGroup !== 0) {
      stackDirections[compactGroup - 1] = stackGroups[rawStackGroupIds[seriesIndex] - 1].direction;
    }
  }
  const barOptions = options.barOptions;

  Object.assign(source, {
    columns: {
      styleIds,
      scaleIds,
      flags,
      visibility,
      ...(stackGroupCount > 0 ? { stackGroupIds } : undefined),
    },
    styles,
    scales,
    stackGroupCount,
    ...(stackGroupCount > 0 ? { stackDirections } : undefined),
    cursorMode: options.cursorMode ?? 'single',
    highlightSeriesOnHover: options.highlightSeriesOnHover !== false,
    focusOverlayColor:
      options.highlightSeriesOnHover === false || options.barOptions?.fullHighlight
        ? undefined
        : colorManipulator.alpha(options.theme.colors.background.canvas, 0.5),
    seriesIdentityAt: getSeriesIdentity,
    seriesIdentityHashAt: getSeriesIdentityHash,
    visibilityState,
    ...(barOptions ? { barLayoutVisibility } : undefined),
    ...(hasValueLabels
      ? {
          formatValueAt: (seriesIndex: number, _index: number, value: number) =>
            formattedValueToString(
              (flags[seriesIndex] & CompactSeriesFlag.PercentStack) !== 0
                ? getPercentDisplay(seriesIndex, getConfigId, getConfig, options, percentDisplays)(value)
                : getDisplay(seriesIndex)(value)
            ),
          valueColor: options.theme.colors.text.primary,
          valueFontFamily: options.theme.typography.fontFamily,
        }
      : undefined),
    ...(barOptions ? { barOptions } : undefined),
  });
  if (!isCompactRenderSource(source)) {
    throw new Error('Compact native renderer source construction failed');
  }
  return source;
}

function hashSeriesIdentity(
  refId: string,
  frameName: string | undefined,
  valueName: string,
  displayNameFromDS: string | undefined,
  labels: Labels | undefined
): number {
  let hash = 2166136261;
  const add = (value = '') => {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16777619);
  };
  add(refId);
  add(frameName);
  add(valueName);
  add(displayNameFromDS);
  for (const [name, value] of Object.entries(labels ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )) {
    add(name);
    add(value);
  }
  return hash >>> 0;
}

function internCompiledConfig(
  config: FieldConfig<GraphFieldConfig>,
  records: CompiledConfigRecord[],
  buckets: Map<number, number[]>,
  styles: CompactNativeStyleRecord[],
  styleBuckets: Map<number, number[]>,
  scales: CompactNativeScaleRecord[],
  scaleBuckets: Map<number, number[]>
): number {
  const displayName = config.displayName;
  const displayNameFromDS = config.displayNameFromDS;
  delete config.displayName;
  delete config.displayNameFromDS;
  try {
    const hash = hashValue(config);
    for (const id of buckets.get(hash) ?? []) {
      if (isEqual(records[id].config, config)) {
        return id;
      }
    }

    const { style, scale } = splitConfig(config);
    const id = records.length;
    records.push({
      config: cloneDeep(config),
      styleId: internStructuralRecord(style, styles, styleBuckets),
      scaleId: internStructuralRecord(scale, scales, scaleBuckets),
    });
    addHashBucket(buckets, hash, id);
    return id;
  } finally {
    if (displayName !== undefined) {
      config.displayName = displayName;
    }
    if (displayNameFromDS !== undefined) {
      config.displayNameFromDS = displayNameFromDS;
    }
  }
}

function internStructuralRecord<T>(record: T, records: T[], buckets: Map<number, number[]>): number {
  const hash = hashValue(record);
  for (const id of buckets.get(hash) ?? []) {
    if (isEqual(records[id], record)) {
      return id;
    }
  }
  const id = records.length;
  records.push(record);
  addHashBucket(buckets, hash, id);
  return id;
}

function addHashBucket(buckets: Map<number, number[]>, hash: number, id: number): void {
  const bucket = buckets.get(hash);
  if (bucket) {
    bucket.push(id);
  } else {
    buckets.set(hash, [id]);
  }
}

function clearRecord(record: object): void {
  for (const key of Object.keys(record)) {
    Reflect.deleteProperty(record, key);
  }
}

function compileRendererConfig(config: FieldConfig<GraphFieldConfig>): RendererConfigRecord {
  const custom = config.custom ?? {};
  const lineWidth = custom.lineWidth ?? 1;
  const configuredPointSize = custom.pointSize ?? 5;
  const defaultPointSize = 3 + Math.max(1, lineWidth) * 2;
  const lineStyle = normalizeCompactLineStyle(custom.lineStyle);

  return {
    config,
    custom,
    colorMode: getFieldColorMode(config.color?.mode),
    drawStyle: custom.drawStyle ?? GraphDrawStyle.Line,
    lineWidth,
    pointSize: !configuredPointSize || configuredPointSize < lineWidth ? defaultPointSize : configuredPointSize,
    pointSpace: defaultPointSize * 2,
    pointLineWidth: Math.max(1, defaultPointSize * 0.2),
    fillAlpha: normalizeCompactFillOpacity(custom.fillOpacity),
    gradientMode: custom.gradientMode ?? GraphGradientMode.None,
    lineDash: lineStyle.dash,
    lineCap: lineStyle.cap,
    disconnectThreshold: normalizeCompactInsertNulls(custom.insertNulls),
    spanNullsThreshold:
      custom.spanNulls === true
        ? Number.POSITIVE_INFINITY
        : typeof custom.spanNulls === 'number'
          ? custom.spanNulls
          : undefined,
    showValues: custom.showValues === true,
    showPoints: custom.showPoints,
    stackingMode: custom.stacking?.mode ?? StackingMode.None,
    stackingGroup: custom.stacking?.group ?? '',
    barAlignment: custom.barAlignment ?? 0,
    barWidthFactor: custom.barWidthFactor ?? 0.6,
    barMaxWidth: custom.barMaxWidth ?? 200,
  };
}

function getStackDirection(
  source: CompactPlotSource,
  seriesIndex: number,
  transform: GraphTransform | undefined,
  samples = 100
): 1 | -1 {
  if (source.pointCount === 0) {
    return 1;
  }
  const usesRawValues = transform === GraphTransform.Constant && source.barWidthValueAt != null;
  const firstIndex = usesRawValues ? 0 : source.nearestPresent(seriesIndex, 0, 1);
  const lastIndex = usesRawValues
    ? source.pointCount - 1
    : source.nearestPresent(seriesIndex, source.pointCount - 1, -1);
  if (firstIndex == null || lastIndex == null) {
    return transform === GraphTransform.NegativeY ? -1 : 1;
  }

  let negativeCount = 0;
  let positiveCount = 0;
  const stride = Math.max(1, Math.floor((lastIndex - firstIndex + 1) / samples));
  for (let index = firstIndex; index <= lastIndex; index += stride) {
    const renderedValue = usesRawValues ? source.barWidthValueAt!(seriesIndex, index) : source.yAt(seriesIndex, index);
    if (renderedValue == null) {
      continue;
    }
    const sourceValue = transform === GraphTransform.NegativeY ? -renderedValue : renderedValue;
    if (sourceValue < 0 || Object.is(sourceValue, -0)) {
      negativeCount++;
    } else if (sourceValue > 0) {
      positiveCount++;
    }
  }

  const sourceIsNegative = negativeCount > positiveCount;
  if (transform === GraphTransform.NegativeY) {
    return sourceIsNegative ? 1 : -1;
  }
  return sourceIsNegative ? -1 : 1;
}

function compactStackGroups(
  rawStackGroupIds: CompactIndexColumn,
  stackGroupCounts: number[],
  flags: CompactIndexColumn,
  preserveSingletons = false
): { stackGroupIds: CompactIndexColumn; stackGroupCount: number } {
  const remappedGroupIds = new Uint32Array(stackGroupCounts.length);
  const requiredGroups = new Uint8Array(stackGroupCounts.length);
  for (let seriesIndex = 0; seriesIndex < rawStackGroupIds.length; seriesIndex++) {
    const groupId = rawStackGroupIds[seriesIndex];
    if (groupId > 0 && (flags[seriesIndex] & (CompactSeriesFlag.PercentStack | CompactSeriesFlag.Constant)) !== 0) {
      requiredGroups[groupId - 1] = 1;
    }
  }
  let stackGroupCount = 0;
  for (let groupIndex = 0; groupIndex < stackGroupCounts.length; groupIndex++) {
    if (stackGroupCounts[groupIndex] > 1 || requiredGroups[groupIndex] !== 0 || preserveSingletons) {
      remappedGroupIds[groupIndex] = ++stackGroupCount;
    }
  }

  if (stackGroupCount === stackGroupCounts.length) {
    return { stackGroupIds: rawStackGroupIds, stackGroupCount };
  }

  const builder = new CompactIndexColumnBuilder(rawStackGroupIds.length);
  for (let seriesIndex = 0; seriesIndex < rawStackGroupIds.length; seriesIndex++) {
    const rawGroupId = rawStackGroupIds[seriesIndex];
    const stackGroupId = rawGroupId === 0 ? 0 : remappedGroupIds[rawGroupId - 1];
    builder.set(seriesIndex, stackGroupId);
    if (stackGroupId === 0) {
      flags[seriesIndex] &= ~(CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack);
    }
  }
  return { stackGroupIds: builder.finish(), stackGroupCount };
}

function compactColumnsEqual(left: CompactIndexColumn | undefined, right: CompactIndexColumn | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function compactStackFlagsEqual(left: CompactIndexColumn, right: CompactIndexColumn): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const mask = CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack;
  for (let index = 0; index < left.length; index++) {
    if ((left[index] & mask) !== (right[index] & mask)) {
      return false;
    }
  }
  return true;
}

function getCachedColorCalculator(
  configId: number,
  target: FieldConfigTarget<GraphFieldConfig>,
  options: CompactFieldConfigOptions,
  cache: Map<number, ReturnType<typeof getFieldColorCalculator>>
): ReturnType<typeof getFieldColorCalculator> {
  let calculator = cache.get(configId);
  if (!calculator) {
    calculator = getFieldColorCalculator(target, options.theme);
    cache.set(configId, calculator);
  }
  return calculator;
}

function getPercentDisplay(
  seriesIndex: number,
  getConfigId: (seriesIndex: number) => number,
  getConfig: (seriesIndex: number) => FieldConfig<GraphFieldConfig>,
  options: CompactFieldConfigOptions,
  cache: Map<number, DisplayProcessor>
): DisplayProcessor {
  const configId = getConfigId(seriesIndex);
  let display = cache.get(configId);
  if (!display) {
    display = getDisplayProcessor({
      field: {
        name: TIME_SERIES_VALUE_FIELD_NAME,
        type: FieldType.number,
        config: { ...getConfig(seriesIndex), unit: 'percentunit' },
      },
      theme: options.theme,
      timeZone: options.timeZone,
    });
    cache.set(configId, display);
  }
  return display;
}

function getCachedScaleCalculator(
  configId: number,
  target: FieldConfigTarget<GraphFieldConfig>,
  options: CompactFieldConfigOptions,
  cache: NumericRangeValueCache<ReturnType<typeof getScaleCalculator>>
): ReturnType<typeof getScaleCalculator> {
  const min = target.state?.range?.min ?? null;
  const max = target.state?.range?.max ?? null;
  return getNumericRangeCacheValue(cache, configId, min, max, () => getScaleCalculator(target, options.theme));
}

function getNumericRangeCacheValue<T>(
  cache: NumericRangeValueCache<T>,
  configId: number,
  min: number | null,
  max: number | null,
  create: () => T
): T {
  let hash = hashValue(configId);
  hash = hashValue(min, hash);
  hash = hashValue(max, hash);
  let bucket = cache.get(hash);
  if (bucket) {
    for (const entry of bucket) {
      if (entry.configId === configId && entry.min === min && entry.max === max) {
        return entry.value;
      }
    }
  } else {
    bucket = [];
    cache.set(hash, bucket);
  }
  const value = create();
  bucket.push({ configId, min, max, value });
  return value;
}

const hashNumberBuffer = new ArrayBuffer(8);
const hashNumberView = new DataView(hashNumberBuffer);

function hashValue(value: unknown, initial = 2166136261): number {
  let hash = initial;

  if (value === null) {
    hash = hashByte(hash, 0);
  } else if (value === undefined) {
    hash = hashByte(hash, 1);
  } else if (typeof value === 'boolean') {
    hash = hashByte(hash, value ? 3 : 2);
  } else if (typeof value === 'number') {
    hash = hashByte(hash, 4);
    hashNumberView.setFloat64(0, value, true);
    for (let index = 0; index < 8; index++) {
      hash = hashByte(hash, hashNumberView.getUint8(index));
    }
  } else if (typeof value === 'string') {
    hash = hashByte(hash, 5);
    hash = hashString(hash, value);
  } else if (Array.isArray(value)) {
    hash = hashByte(hash, 6);
    for (const item of value) {
      hash = hashValue(item, hash);
    }
  } else if (typeof value === 'object') {
    hash = hashByte(hash, 7);
    for (const key of Object.keys(value).sort()) {
      hash = hashString(hash, key);
      hash = hashValue(Reflect.get(value, key), hash);
    }
  } else {
    hash = hashByte(hash, 8);
    hash = hashString(hash, String(value));
  }
  return hash >>> 0;
}

function hashByte(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, 16777619);
}

function hashString(initial: number, value: string): number {
  let hash = initial;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    hash = hashByte(hash, code & 0xff);
    hash = hashByte(hash, code >>> 8);
  }
  return hash;
}

function createScaleRecord(key: string, config: FieldConfig<GraphFieldConfig>, axisColor: string): CompactScaleRecord {
  const distribution = config.custom?.scaleDistribution;
  return {
    key,
    mode: distribution?.type === ScaleDistribution.Log ? 'positive' : 'all',
    min: config.min,
    max: config.max,
    softMin: config.custom?.axisSoftMin,
    softMax: config.custom?.axisSoftMax,
    distribution: distribution?.type ?? ScaleDistribution.Linear,
    log: distribution?.log,
    linearThreshold: distribution?.linearThreshold,
    centeredZero: config.custom?.axisCenteredZero,
    decimals: config.decimals ?? undefined,
    axisColor,
  };
}

function getPathFlag(interpolation: LineInterpolation | undefined): CompactSeriesFlag {
  switch (interpolation) {
    case LineInterpolation.StepBefore:
      return CompactSeriesFlag.StepBefore;
    case LineInterpolation.StepAfter:
      return CompactSeriesFlag.StepAfter;
    case LineInterpolation.Smooth:
      return CompactSeriesFlag.Spline;
    default:
      return CompactSeriesFlag.Linear;
  }
}

function createSeriesAccess(data: CompactTimeSeriesData): CompactSeriesAccess {
  if (isCompactTimeSeriesSeriesCollection(data.series)) {
    return createColumnarSeriesAccess(data.series);
  }
  const series = data.series;
  return {
    getAxisId: (index) => series[index].axisId,
    getRefId: (index) => series[index].refId,
    getFrameName: (index) => series[index].frameName,
    getValueName: (index) => series[index].valueName,
    getDisplayNameFromDS: (index) => series[index].displayNameFromDS,
    getLabelCount: (index) => series[index].labelCount,
    getLabel: (index, name) => data.metadata.getLabel(series[index], name),
    forEachLabel: (index, callback) => data.metadata.forEachLabel(series[index], callback),
    getSharedLabelName: () => {
      let sharedName: string | null = null;
      for (let index = 0; index < series.length; index++) {
        let multiple = false;
        data.metadata.forEachLabel(series[index], (name) => {
          if (sharedName == null) {
            sharedName = name;
          } else if (sharedName !== name) {
            multiple = true;
          }
        });
        if (multiple) {
          return null;
        }
      }
      return sharedName;
    },
    getIdentityHash: (index) =>
      hashSeriesIdentity(
        series[index].refId,
        series[index].frameName,
        series[index].valueName,
        series[index].displayNameFromDS,
        data.metadata.materializeLabels(series[index])
      ),
    getPresenceByteOffset: (index) => series[index].presenceByteOffset,
    getPresenceByteLength: (index) => series[index].presenceByteLength,
    getPresentCount: (index) => series[index].presentCount,
    getValuesByteOffset: (index) => series[index].valuesByteOffset,
  };
}

function createColumnarSeriesAccess(series: CompactTimeSeriesSeriesCollection): CompactSeriesAccess {
  const columnIndex = (index: number) => series.resolveColumnIndex(index);
  return {
    getAxisId: (index) => series.columns.axisIds[columnIndex(index)],
    getRefId: (index) => series.getRefId(index),
    getFrameName: (index) => series.getFrameName(index),
    getValueName: (index) => series.getValueName(index),
    getDisplayNameFromDS: (index) => series.getDisplayNameFromDS(index),
    getLabelCount: (index) => series.columns.labelCounts[columnIndex(index)],
    getLabel: (index, name) => series.getLabel(index, name),
    forEachLabel: (index, callback) => series.forEachLabel(index, callback),
    getSharedLabelName: () => series.getSharedLabelName(),
    getIdentityHash: (index) => series.getIdentityHash(index),
    getPresenceByteOffset: (index) => series.columns.presenceByteOffsets[columnIndex(index)],
    getPresenceByteLength: (index) => series.columns.presenceByteLengths[columnIndex(index)],
    getPresentCount: (index) => series.columns.presentCounts[columnIndex(index)],
    getValuesByteOffset: (index) => series.columns.valuesByteOffsets[columnIndex(index)],
  };
}

function calculateFrameNamesDiffer(access: CompactSeriesAccess, seriesCount: number): boolean {
  const first = seriesCount > 0 ? access.getFrameName(0) : undefined;
  for (let index = 1; index < seriesCount; index++) {
    if (access.getFrameName(index) !== first) {
      return true;
    }
  }
  return false;
}

function calculateLabelProfile(access: CompactSeriesAccess, seriesCount: number): LabelProfile {
  return { singleLabelName: seriesCount > 0 ? access.getSharedLabelName() : null };
}

function matchesSeries(
  matcherId: string,
  matcherOptions: unknown,
  valueMatcher: CompactValueMatcher | undefined,
  seriesIndex: number,
  config: FieldConfig<GraphFieldConfig>,
  data: CompactTimeSeriesData,
  dataView: DataView,
  dataBytes: Uint8Array,
  access: CompactSeriesAccess,
  getFrameNamesDiffer: () => boolean,
  getLabelProfile: () => LabelProfile,
  medianWorkspace: CompactMedianWorkspace,
  medianMatcherMemo: MedianMatcherMemo
): boolean {
  switch (matcherId) {
    case FieldMatcherID.numeric:
      return true;
    case FieldMatcherID.time:
    case FieldMatcherID.first:
    case FieldMatcherID.firstTimeField:
      return false;
    case FieldMatcherID.byType:
      return matcherOptions === FieldType.number;
    case FieldMatcherID.byTypes:
      return matcherOptions instanceof Set
        ? matcherOptions.has(FieldType.number)
        : Array.isArray(matcherOptions) && matcherOptions.includes(FieldType.number);
    case FieldMatcherID.byFrameRefID:
      return access.getRefId(seriesIndex) === matcherOptions;
    case FieldMatcherID.byName:
      return matchesName(
        String(matcherOptions ?? ''),
        seriesIndex,
        config,
        data.series.length,
        access,
        getFrameNamesDiffer(),
        getLabelProfile()
      );
    case FieldMatcherID.byNames: {
      const names = getStringArrayProperty(matcherOptions, 'names');
      const matched = names.some((name) =>
        matchesName(name, seriesIndex, config, data.series.length, access, getFrameNamesDiffer(), getLabelProfile())
      );
      return getStringProperty(matcherOptions, 'mode') === 'exclude' ? !matched : matched;
    }
    case FieldMatcherID.byRegexp: {
      const regexp = compileRegex(String(matcherOptions ?? ''));
      return regexp.test(calculateDisplayName(seriesIndex, config, access, getFrameNamesDiffer(), getLabelProfile()));
    }
    case FieldMatcherID.byRegexpOrNames: {
      const names = getStringArrayProperty(matcherOptions, 'names');
      const nameMatched = names.some((name) =>
        matchesName(name, seriesIndex, config, data.series.length, access, getFrameNamesDiffer(), getLabelProfile())
      );
      const regexp = compileRegex(getStringProperty(matcherOptions, 'pattern') ?? '');
      return (
        nameMatched ||
        regexp.test(calculateDisplayName(seriesIndex, config, access, getFrameNamesDiffer(), getLabelProfile()))
      );
    }
    case FieldMatcherID.byValue:
      if (!valueMatcher) {
        throw new Error('Compact native value matcher was not compiled');
      }
      return matchesValue(
        valueMatcher,
        data,
        dataView,
        dataBytes,
        access,
        seriesIndex,
        config,
        medianWorkspace,
        medianMatcherMemo
      );
    default:
      throw new Error(`Compact native field matcher ${matcherId} is unsupported`);
  }
}

function matchesName(
  name: string,
  seriesIndex: number,
  config: FieldConfig<GraphFieldConfig>,
  seriesCount: number,
  access: CompactSeriesAccess,
  frameNamesDiffer: boolean,
  labelProfile: LabelProfile
): boolean {
  const matchName = getMatchName(access, seriesIndex);
  if (
    name === matchName ||
    name === calculateDisplayName(seriesIndex, config, access, frameNamesDiffer, labelProfile)
  ) {
    return true;
  }
  if (name === TIME_SERIES_VALUE_FIELD_NAME) {
    return access.getLabel(seriesIndex, '__name__') === matchName;
  }
  return seriesCount === 1 && name === getFieldName(access, seriesIndex);
}

function matchesValue(
  matcher: CompactValueMatcher,
  data: CompactTimeSeriesData,
  dataView: DataView,
  dataBytes: Uint8Array,
  access: CompactSeriesAccess,
  seriesIndex: number,
  config: FieldConfig<GraphFieldConfig>,
  medianWorkspace: CompactMedianWorkspace,
  medianMatcherMemo: MedianMatcherMemo
): boolean {
  const { reducer, operation, value } = matcher;
  const left =
    reducer === ReducerID.median
      ? reduceCompactMedianMatcher(dataView, access, seriesIndex, config, medianWorkspace, medianMatcherMemo)
      : reduceCompactSourceSeries(dataView, access, seriesIndex, config, reducer, medianWorkspace);
  if (reducer === ReducerID.allIsNull || reducer === ReducerID.allIsZero) {
    return Boolean(left);
  }
  if (!isComparableValue(left)) {
    return false;
  }
  return compareValues(left, operation, value);
}

function calculateDisplayName(
  seriesIndex: number,
  config: FieldConfig<GraphFieldConfig>,
  access: CompactSeriesAccess,
  frameNamesDiffer: boolean,
  labelProfile: LabelProfile,
  ignoreConfiguredDisplayName = false
): string {
  if (!ignoreConfiguredDisplayName && config.displayName) {
    return config.displayName;
  }
  const displayNameFromDS = access.getDisplayNameFromDS(seriesIndex);
  if (displayNameFromDS) {
    return displayNameFromDS;
  }

  const matchName = getMatchName(access, seriesIndex);
  const frameName = access.getFrameName(seriesIndex);
  const parts: string[] = [];
  let frameNameAdded = false;
  let labelsAdded = false;
  if (frameNamesDiffer && frameName) {
    parts.push(frameName);
    frameNameAdded = true;
  }
  if (matchName && matchName !== TIME_SERIES_VALUE_FIELD_NAME) {
    parts.push(matchName);
  }
  if (access.getLabelCount(seriesIndex) > 0) {
    const labelText = labelProfile.singleLabelName
      ? access.getLabel(seriesIndex, labelProfile.singleLabelName)
      : formatLabels(access, seriesIndex);
    if (labelText) {
      parts.push(labelText);
      labelsAdded = true;
    }
  }
  if (!frameNameAdded && !labelsAdded && matchName === TIME_SERIES_VALUE_FIELD_NAME && frameName) {
    parts.push(frameName);
  }
  return parts.length > 0 ? parts.join(' ') : matchName || TIME_SERIES_VALUE_FIELD_NAME;
}

function replaceCompactVariables(
  value: string,
  seriesIndex: number,
  config: FieldConfig<GraphFieldConfig>,
  access: CompactSeriesAccess,
  frameNamesDiffer: boolean,
  getLabelProfile: () => LabelProfile
): string {
  if (!value.includes('__field') && !value.includes('__series')) {
    return value;
  }
  const displayName = calculateDisplayName(seriesIndex, config, access, frameNamesDiffer, getLabelProfile(), true);
  return value.replace(
    /\$\{(__field\.(?:name|displayName|labels(?:\.[^}:]+)?)|__series\.name)(?::[^}]*)?\}/g,
    (match, variable: string) => {
      if (variable === '__field.name') {
        return getFieldName(access, seriesIndex);
      }
      if (variable === '__field.displayName') {
        return displayName;
      }
      if (variable === '__field.labels') {
        return formatLabels(access, seriesIndex, true, true);
      }
      if (variable.startsWith('__field.labels.')) {
        const labelName = variable.slice('__field.labels.'.length);
        if (labelName === 'name' && frameNameShouldBeLabel(access, seriesIndex)) {
          return access.getFrameName(seriesIndex) ?? '';
        }
        return access.getLabel(seriesIndex, labelName) ?? '';
      }
      if (variable === '__series.name') {
        return access.getFrameName(seriesIndex) ?? displayName;
      }
      return match;
    }
  );
}

function formatLabels(
  access: CompactSeriesAccess,
  seriesIndex: number,
  withoutBraces = false,
  includeSyntheticName = false
): string {
  const labels: Array<[string, string]> = [];
  access.forEachLabel(seriesIndex, (name, value) => labels.push([name, value]));
  if (includeSyntheticName && frameNameShouldBeLabel(access, seriesIndex)) {
    labels.push(['name', access.getFrameName(seriesIndex)!]);
  }
  if (labels.length === 0) {
    return '';
  }
  labels.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const formatted = labels.map(([name, value]) => `${name}="${value}"`).join(', ');
  return withoutBraces ? formatted : `{${formatted}}`;
}

function frameNameShouldBeLabel(access: CompactSeriesAccess, seriesIndex: number): boolean {
  return Boolean(
    access.getFrameName(seriesIndex) &&
      getMatchName(access, seriesIndex) !== TIME_SERIES_VALUE_FIELD_NAME &&
      access.getLabel(seriesIndex, 'name') == null
  );
}

function getMatchName(access: CompactSeriesAccess, seriesIndex: number): string {
  return access.getValueName(seriesIndex) || TIME_SERIES_VALUE_FIELD_NAME;
}

function getFieldName(access: CompactSeriesAccess, seriesIndex: number): string {
  const matchName = getMatchName(access, seriesIndex);
  return matchName === TIME_SERIES_VALUE_FIELD_NAME && access.getFrameName(seriesIndex)
    ? access.getFrameName(seriesIndex)!
    : matchName;
}

function splitConfig(config: FieldConfig<GraphFieldConfig>): {
  style: CompactNativeStyleRecord;
  scale: CompactNativeScaleRecord;
} {
  const styleConfig = cloneDeep(config);
  delete styleConfig.displayName;
  delete styleConfig.displayNameFromDS;
  delete styleConfig.unit;
  delete styleConfig.decimals;
  delete styleConfig.min;
  delete styleConfig.max;
  delete styleConfig.fieldMinMax;
  delete styleConfig.thresholds;

  const scaleConfig: FieldConfig<GraphFieldConfig> = {};
  copyDefined(scaleConfig, config, 'unit');
  copyDefined(scaleConfig, config, 'decimals');
  copyDefined(scaleConfig, config, 'min');
  copyDefined(scaleConfig, config, 'max');
  copyDefined(scaleConfig, config, 'fieldMinMax');
  copyDefined(scaleConfig, config, 'thresholds');

  if (config.custom) {
    const scaleCustom: GraphFieldConfig = {};
    for (const property of scaleCustomProperties) {
      copyDefined(scaleCustom, config.custom, property);
      if (styleConfig.custom) {
        delete styleConfig.custom[property];
      }
    }
    if (Object.keys(scaleCustom).length > 0) {
      scaleConfig.custom = cloneDeep(scaleCustom);
    }
    if (styleConfig.custom && Object.keys(styleConfig.custom).length === 0) {
      delete styleConfig.custom;
    }
  }

  return {
    style: { config: styleConfig },
    scale: { config: scaleConfig },
  };
}

function calculateFlags(
  config: FieldConfig<GraphFieldConfig>,
  configuredHideFrom: HideSeriesConfig,
  presenceByteLength: number,
  capability: CompactFieldConfigOptions['capability']
): number {
  const custom = config.custom;
  let flags = presenceByteLength > 0 ? CompactNativeSeriesFlag.HasGaps : 0;
  if (custom?.hideFrom?.viz) {
    flags |= CompactNativeSeriesFlag.HiddenFromViz;
  }
  if (configuredHideFrom.legend) {
    flags |= CompactNativeSeriesFlag.HiddenFromLegend;
  }
  const hiddenFromTooltip =
    capability === 'standalone-barchart'
      ? configuredHideFrom.tooltip || (!configuredHideFrom.viz && custom?.hideFrom?.viz === true)
      : custom?.hideFrom?.tooltip === true;
  if (hiddenFromTooltip) {
    flags |= CompactNativeSeriesFlag.HiddenFromTooltip;
  }
  if (custom?.transform === GraphTransform.NegativeY) {
    flags |= CompactNativeSeriesFlag.NegativeY;
  }
  if (custom?.transform === GraphTransform.Constant) {
    flags |= CompactNativeSeriesFlag.Constant;
  }
  return flags;
}

function calculateCompactMinMax(
  data: CompactTimeSeriesData,
  dataView: DataView,
  dataBytes: Uint8Array,
  access: CompactSeriesAccess,
  seriesIndex: number,
  config: Readonly<FieldConfig<GraphFieldConfig>>
): Pick<NumericRange, 'min' | 'max'> {
  const nullMode = config.nullValueMode ?? NullValueMode.Ignore;
  let min: number | null = null;
  let max: number | null = null;
  forEachRawValue(data, dataView, dataBytes, access, seriesIndex, (sourceValue) => {
    let value = sourceValue;
    if (value == null) {
      if (nullMode === NullValueMode.Ignore) {
        return;
      }
      if (nullMode === NullValueMode.AsZero) {
        value = 0;
      }
    }
    if (value == null || Number.isNaN(value)) {
      return;
    }
    min = min == null || value < min ? value : min;
    max = max == null || value > max ? value : max;
  });
  return { min, max };
}

function calculateCompactSourceMinMax(
  dataView: DataView,
  access: CompactSeriesAccess,
  seriesIndex: number,
  config: Readonly<FieldConfig<GraphFieldConfig>>
): Pick<NumericRange, 'min' | 'max'> {
  const nullMode = config.nullValueMode ?? NullValueMode.Ignore;
  let min: number | null = null;
  let max: number | null = null;
  forEachSourceValue(dataView, access, seriesIndex, (sourceValue) => {
    let value = sourceValue;
    if (value == null) {
      if (nullMode === NullValueMode.Ignore) {
        return;
      }
      if (nullMode === NullValueMode.AsZero) {
        value = 0;
      }
    }
    if (value == null || Number.isNaN(value)) {
      return;
    }
    min = min == null || value < min ? value : min;
    max = max == null || value > max ? value : max;
  });
  return { min, max };
}

class CompactMedianWorkspace {
  private values = new Float64Array(0);

  calculate(
    maximumLength: number,
    nullMode: NullValueMode,
    iterate: (callback: (value: number | null, index: number) => void) => void
  ): number | null | undefined {
    if (maximumLength === 0) {
      return undefined;
    }
    if (maximumLength > this.values.length) {
      this.values = new Float64Array(maximumLength);
    }

    let length = 0;
    let negativeCount = 0;
    iterate((sourceValue) => {
      let value = normalizeCompactMedianValue(sourceValue);
      if (value == null) {
        if (nullMode === NullValueMode.Ignore) {
          return;
        }
        value = 0;
      }
      if (length >= maximumLength) {
        throw new Error('Compact median input exceeds its declared length');
      }
      this.values[length++] = value;
      if (value < 0) {
        negativeCount++;
      }
    });

    if (length === 0) {
      return Number.NaN;
    }

    const middle = Math.floor(length / 2);
    const upper = selectCompactMedianValue(this.values, length, middle);
    if (length % 2 === 0) {
      const lower =
        middle - 1 >= upper.equalStart ? upper.value : findMaximumCompactMedianValue(this.values, upper.equalStart);
      return (lower + upper.value) / 2;
    }

    if (nullMode !== NullValueMode.Null || upper.value !== 0) {
      return upper.value;
    }

    const zeroOffset = middle - negativeCount;
    let zeroIndex = 0;
    let result: number | null = 0;
    iterate((sourceValue) => {
      const value = normalizeCompactMedianValue(sourceValue);
      if (value != null && value !== 0) {
        return;
      }
      if (zeroIndex === zeroOffset) {
        result = value;
      }
      zeroIndex++;
    });
    return result;
  }
}

function normalizeCompactMedianValue(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}

function selectCompactMedianValue(
  values: Float64Array,
  length: number,
  target: number
): { value: number; equalStart: number } {
  let left = 0;
  let right = length - 1;
  while (left <= right) {
    const middle = left + ((right - left) >> 1);
    const pivot = medianOfThree(values[left], values[middle], values[right]);
    let lower = left;
    let scan = left;
    let upper = right;

    while (scan <= upper) {
      const value = values[scan];
      if (value < pivot) {
        swapCompactMedianValues(values, lower++, scan++);
      } else if (value > pivot) {
        swapCompactMedianValues(values, scan, upper--);
      } else {
        scan++;
      }
    }

    if (target < lower) {
      right = lower - 1;
    } else if (target > upper) {
      left = upper + 1;
    } else {
      return { value: pivot, equalStart: lower };
    }
  }
  throw new Error('Compact median selection failed');
}

function medianOfThree(left: number, middle: number, right: number): number {
  if (left > middle) {
    const value = left;
    left = middle;
    middle = value;
  }
  if (middle > right) {
    const value = middle;
    middle = right;
    right = value;
  }
  return left > middle ? left : middle;
}

function swapCompactMedianValues(values: Float64Array, left: number, right: number): void {
  const value = values[left];
  values[left] = values[right];
  values[right] = value;
}

function findMaximumCompactMedianValue(values: Float64Array, length: number): number {
  if (length === 0) {
    throw new Error('Compact median lower partition is empty');
  }
  let maximum = values[0];
  for (let index = 1; index < length; index++) {
    if (values[index] > maximum) {
      maximum = values[index];
    }
  }
  return maximum;
}

function reduceCompactMedianMatcher(
  dataView: DataView,
  access: CompactSeriesAccess,
  seriesIndex: number,
  config: Readonly<FieldConfig<GraphFieldConfig>>,
  medianWorkspace: CompactMedianWorkspace,
  memo: MedianMatcherMemo
): unknown {
  if (memo.seriesIndex !== seriesIndex) {
    memo.seriesIndex = seriesIndex;
    memo.cache.states.fill(REDUCTION_UNSET);
  }
  const nullMode = config.nullValueMode ?? NullValueMode.Ignore;
  const cacheIndex = getCompactNullModeIndex(nullMode);
  if (memo.cache.states[cacheIndex] === REDUCTION_UNSET) {
    writeReduction(
      memo.cache,
      cacheIndex,
      reduceCompactSourceSeries(dataView, access, seriesIndex, config, ReducerID.median, medianWorkspace)
    );
  }
  return readReduction(memo.cache, cacheIndex);
}

function getCompactNullModeIndex(nullMode: NullValueMode): number {
  switch (nullMode) {
    case NullValueMode.Ignore:
      return 0;
    case NullValueMode.Null:
      return 1;
    case NullValueMode.AsZero:
      return 2;
  }
}

function reduceCompactSeries(
  data: CompactTimeSeriesData,
  dataView: DataView,
  dataBytes: Uint8Array,
  access: CompactSeriesAccess,
  seriesIndex: number,
  config: Readonly<FieldConfig<GraphFieldConfig>>,
  reducer: ReducerID,
  medianWorkspace: CompactMedianWorkspace
): unknown {
  const axis = data.axes[access.getAxisId(seriesIndex)];
  if (!axis) {
    throw new Error(`Compact native series ${seriesIndex} references a missing axis`);
  }
  return reduceCompactValues(
    config,
    reducer,
    (callback) => forEachRawValue(data, dataView, dataBytes, access, seriesIndex, callback),
    axis.count,
    medianWorkspace
  );
}

function reduceCompactSourceSeries(
  dataView: DataView,
  access: CompactSeriesAccess,
  seriesIndex: number,
  config: Readonly<FieldConfig<GraphFieldConfig>>,
  reducer: ReducerID,
  medianWorkspace: CompactMedianWorkspace
): unknown {
  return reduceCompactValues(
    config,
    reducer,
    (callback) => forEachSourceValue(dataView, access, seriesIndex, callback),
    access.getPresentCount(seriesIndex),
    medianWorkspace
  );
}

function reduceCompactValues(
  config: Readonly<FieldConfig<GraphFieldConfig>>,
  reducer: ReducerID,
  iterate: (callback: (value: number | null, index: number) => void) => void,
  maximumLength: number,
  medianWorkspace: CompactMedianWorkspace
): unknown {
  const nullMode = config.nullValueMode ?? NullValueMode.Ignore;
  if (reducer === ReducerID.median) {
    return medianWorkspace.calculate(maximumLength, nullMode, iterate);
  }
  let first: number | null | undefined;
  let last: number | null | undefined;
  let firstNotNull: number | null = null;
  let lastNotNull: number | null = null;
  let min: number | null = null;
  let max: number | null = null;
  let logmin: number | null = null;
  let sum = 0;
  let count = 0;
  let nonNullCount = 0;
  let allIsNull = true;
  let allIsZero = true;
  let delta = 0;
  let step: number | null = null;
  let previousDeltaUp = true;
  let changeCount = 0;
  let previousComparable: number | null | undefined;
  let hasComparable = false;
  let varianceCount = 0;
  let varianceMean = 0;
  let varianceSquareSum = 0;
  let totalCount = 0;

  iterate((sourceValue, valueIndex) => {
    totalCount++;
    if (sourceValue != null) {
      varianceCount++;
      const oldMean = varianceMean;
      varianceMean += (sourceValue - oldMean) / varianceCount;
      varianceSquareSum += (sourceValue - oldMean) * (sourceValue - varianceMean);
    }
    let value = sourceValue;
    if (valueIndex === 0) {
      first = value;
    }
    last = value;
    if (value == null) {
      if (nullMode === NullValueMode.Ignore) {
        return;
      }
      if (nullMode === NullValueMode.AsZero) {
        value = 0;
      }
    }
    count++;
    if (hasComparable && previousComparable !== value) {
      changeCount++;
    }
    previousComparable = value;
    hasComparable = true;
    if (value == null || Number.isNaN(value)) {
      return;
    }
    if (firstNotNull == null) {
      firstNotNull = value;
    }
    sum += value;
    allIsNull = false;
    nonNullCount++;
    if (lastNotNull != null) {
      const valueStep = value - lastNotNull;
      step = step == null || valueStep < step ? valueStep : step;
      if (lastNotNull > value) {
        previousDeltaUp = false;
      } else {
        if (previousDeltaUp) {
          delta += valueStep;
        }
        previousDeltaUp = true;
      }
    }
    min = min == null || value < min ? value : min;
    max = max == null || value > max ? value : max;
    logmin = value > 0 && (logmin == null || value < logmin) ? value : logmin;
    if (value !== 0) {
      allIsZero = false;
    }
    lastNotNull = value;
  });

  if (allIsNull) {
    allIsZero = false;
  }
  const diff = firstNotNull != null && lastNotNull != null ? lastNotNull - firstNotNull : null;
  const variance = varianceCount > 0 ? varianceSquareSum / varianceCount : 0;
  switch (reducer) {
    case ReducerID.first:
      return first;
    case ReducerID.last:
      return last;
    case ReducerID.firstNotNull:
      return firstNotNull;
    case ReducerID.lastNotNull:
      return lastNotNull;
    case ReducerID.sum:
      return sum;
    case ReducerID.min:
      return min;
    case ReducerID.max:
      return max;
    case ReducerID.logmin:
      return logmin;
    case ReducerID.mean:
      return nonNullCount > 0 ? sum / nonNullCount : null;
    case ReducerID.range:
      return min != null && max != null ? max - min : null;
    case ReducerID.count:
      return count;
    case ReducerID.countAll:
      return totalCount;
    case ReducerID.diff:
      return diff;
    case ReducerID.diffperc:
      return firstNotNull != null && diff != null ? (diff / firstNotNull) * 100 : 0;
    case ReducerID.delta:
      return delta;
    case ReducerID.step:
      return step;
    case ReducerID.allIsNull:
      return allIsNull;
    case ReducerID.allIsZero:
      return allIsZero;
    case ReducerID.changeCount:
      return changeCount;
    case ReducerID.variance:
      return variance;
    case ReducerID.stdDev:
      return Math.sqrt(variance);
    default:
      throw new Error(`Compact native reducer ${reducer} is unsupported`);
  }
}

function forEachSourceValue(
  dataView: DataView,
  access: CompactSeriesAccess,
  seriesIndex: number,
  callback: (value: number | null, sourceIndex: number) => void
): void {
  const presentCount = access.getPresentCount(seriesIndex);
  const valuesByteOffset = access.getValuesByteOffset(seriesIndex);
  for (let sourceIndex = 0; sourceIndex < presentCount; sourceIndex++) {
    callback(dataView.getFloat64(valuesByteOffset + sourceIndex * Float64Array.BYTES_PER_ELEMENT, true), sourceIndex);
  }
}

function forEachRawValue(
  data: CompactTimeSeriesData,
  dataView: DataView,
  dataBytes: Uint8Array,
  access: CompactSeriesAccess,
  seriesIndex: number,
  callback: (value: number | null, axisIndex: number) => void
) {
  const axis = data.axes[access.getAxisId(seriesIndex)];
  if (!axis) {
    throw new Error(`Compact native series ${seriesIndex} references a missing axis`);
  }
  const presenceByteOffset = access.getPresenceByteOffset(seriesIndex);
  const presenceByteLength = access.getPresenceByteLength(seriesIndex);
  const valuesByteOffset = access.getValuesByteOffset(seriesIndex);
  let packedIndex = 0;
  for (let axisIndex = 0; axisIndex < axis.count; axisIndex++) {
    const present =
      presenceByteLength === 0 || (dataBytes[presenceByteOffset + (axisIndex >> 3)] & (1 << (axisIndex & 7))) !== 0;
    if (!present) {
      callback(null, axisIndex);
      continue;
    }
    const value = dataView.getFloat64(valuesByteOffset + packedIndex * Float64Array.BYTES_PER_ELEMENT, true);
    packedIndex++;
    callback(Number.isFinite(value) ? value : null, axisIndex);
  }
}

function internOptionalString(value: string | undefined, values: string[], keys: Map<string, number>): number {
  if (!value) {
    return NO_STRING_ID;
  }
  const existing = keys.get(value);
  if (existing != null) {
    return existing;
  }
  const id = values.length + 1;
  values.push(value);
  keys.set(value, id);
  return id;
}

function getReductionCacheChunk(cache: ReductionCache, seriesIndex: number): ReductionCacheChunk {
  const chunkId = Math.floor(seriesIndex / LAZY_CACHE_CHUNK_SIZE);
  let chunk = cache.chunks.get(chunkId);
  if (!chunk) {
    chunk = {
      states: new Uint8Array(LAZY_CACHE_CHUNK_SIZE),
      values: new Float64Array(LAZY_CACHE_CHUNK_SIZE),
    };
    cache.chunks.set(chunkId, chunk);
  }
  return chunk;
}

function getRangeCacheChunk(cache: Map<number, RangeCacheChunk>, seriesIndex: number): RangeCacheChunk {
  const chunkId = Math.floor(seriesIndex / LAZY_CACHE_CHUNK_SIZE);
  let chunk = cache.get(chunkId);
  if (!chunk) {
    chunk = {
      states: new Uint8Array(LAZY_CACHE_CHUNK_SIZE),
      mins: new Float64Array(LAZY_CACHE_CHUNK_SIZE),
      maxs: new Float64Array(LAZY_CACHE_CHUNK_SIZE),
    };
    cache.set(chunkId, chunk);
  }
  return chunk;
}

function writeReduction(cache: ReductionCacheChunk, seriesIndex: number, value: unknown) {
  if (value === null) {
    cache.states[seriesIndex] = REDUCTION_NULL;
  } else if (value === undefined) {
    cache.states[seriesIndex] = REDUCTION_UNDEFINED;
  } else if (value === false) {
    cache.states[seriesIndex] = REDUCTION_FALSE;
  } else if (value === true) {
    cache.states[seriesIndex] = REDUCTION_TRUE;
  } else if (typeof value === 'number') {
    cache.values[seriesIndex] = value;
    cache.states[seriesIndex] = REDUCTION_NUMBER;
  } else {
    throw new Error(`Compact native reducer returned unsupported value ${String(value)}`);
  }
}

function readReduction(cache: ReductionCacheChunk, seriesIndex: number): unknown {
  switch (cache.states[seriesIndex]) {
    case REDUCTION_NUMBER:
      return cache.values[seriesIndex];
    case REDUCTION_NULL:
      return null;
    case REDUCTION_UNDEFINED:
      return undefined;
    case REDUCTION_FALSE:
      return false;
    case REDUCTION_TRUE:
      return true;
    default:
      throw new Error(`Compact native reduction cache is unset for series ${seriesIndex}`);
  }
}

function assertSeriesIndex(seriesIndex: number, seriesCount: number): number {
  if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || seriesIndex >= seriesCount) {
    throw new RangeError(`Compact native series index ${seriesIndex} is out of range`);
  }
  return seriesIndex;
}

function copyDefined<T extends object, K extends keyof T>(target: T, source: T, property: K) {
  if (source[property] !== undefined) {
    target[property] = cloneDeep(source[property]);
  }
}

function compileRegex(pattern: string): RegExp {
  try {
    return stringToJsRegex(pattern);
  } catch (error) {
    throw new Error(`Compact native field matcher has an invalid regular expression: ${pattern}`, { cause: error });
  }
}

function getProperty(value: unknown, property: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, property) : undefined;
}

function getStringProperty(value: unknown, property: string): string | undefined {
  const propertyValue = getProperty(value, property);
  return typeof propertyValue === 'string' ? propertyValue : undefined;
}

function getStringArrayProperty(value: unknown, property: string): string[] {
  const propertyValue = getProperty(value, property);
  return Array.isArray(propertyValue) && propertyValue.every((item) => typeof item === 'string') ? propertyValue : [];
}

function getReducerId(value: unknown): ReducerID | undefined {
  return typeof value === 'string' && reducerIds.has(value) ? reducerValues.find((id) => id === value) : undefined;
}

function isComparableValue(value: unknown): value is string | number | boolean | null | undefined {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
