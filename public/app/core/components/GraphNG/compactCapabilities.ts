import tinycolor from 'tinycolor2';

import {
  FieldColorModeId,
  FieldConfigProperty,
  FieldConfigSource,
  FieldMatcherID,
  isCompactTimeSeriesReducerSupported,
  ReducerID,
  stringToJsRegex,
} from '@grafana/data';
import {
  AxisColorMode,
  AxisPlacement,
  BarAlignment,
  ComparisonOperation,
  GraphDrawStyle,
  GraphFieldConfig,
  GraphGradientMode,
  GraphThresholdsStyleMode,
  GraphTransform,
  LineInterpolation,
  ScaleDistribution,
  StackingMode,
  VisibilityMode,
} from '@grafana/schema';

type CompactCapability = 'supported' | 'legacy-inert' | 'unsupported';

export type CompactPanelCapability = 'timeseries-line' | 'timeseries-bars' | 'standalone-barchart';

const alwaysInertProperties = ['fillColor', 'pointColor', 'pointSymbol'] as const;
const lineOnlyInertProperties = ['barAlignment', 'barMaxWidth', 'barWidthFactor'] as const;
const thresholdStyleModes = new Set<unknown>(Object.values(GraphThresholdsStyleMode));
const comparisonOperationValues = Object.values(ComparisonOperation);
const reducerValues = Object.values(ReducerID);
const supportedMatcherIds = new Set<string>([
  FieldMatcherID.numeric,
  FieldMatcherID.time,
  FieldMatcherID.first,
  FieldMatcherID.firstTimeField,
  FieldMatcherID.byType,
  FieldMatcherID.byTypes,
  FieldMatcherID.byName,
  FieldMatcherID.byNames,
  FieldMatcherID.byRegexp,
  FieldMatcherID.byRegexpOrNames,
  FieldMatcherID.byFrameRefID,
  FieldMatcherID.byValue,
]);

export interface CompactValueMatcher {
  readonly reducer: ReducerID;
  readonly operation: ComparisonOperation;
  readonly value?: number;
}

function classifyCompactCustomProperty(
  property: string,
  value: unknown,
  capability: CompactPanelCapability
): CompactCapability {
  switch (property) {
    case 'axisBorderShow':
    case 'axisCenteredZero':
    case 'axisGridShow':
      return value == null || typeof value === 'boolean' ? 'supported' : 'unsupported';
    case 'axisColorMode':
      return value == null || value === AxisColorMode.Text || value === AxisColorMode.Series
        ? 'supported'
        : 'unsupported';
    case 'axisLabel':
      return value == null || typeof value === 'string' ? 'supported' : 'unsupported';
    case 'axisPlacement':
      return value == null ||
        value === AxisPlacement.Auto ||
        value === AxisPlacement.Left ||
        value === AxisPlacement.Right ||
        value === AxisPlacement.Hidden
        ? 'supported'
        : 'unsupported';
    case 'axisSoftMax':
    case 'axisSoftMin':
      return value == null || isFiniteNumber(value) ? 'supported' : 'unsupported';
    case 'axisWidth':
    case 'lineWidth':
    case 'pointSize':
      return value == null || isFiniteNumberInRange(value, 0, Number.POSITIVE_INFINITY) ? 'supported' : 'unsupported';
    case 'barAlignment':
      return value == null ||
        value === BarAlignment.Before ||
        value === BarAlignment.Center ||
        value === BarAlignment.After
        ? capability === 'timeseries-line'
          ? 'legacy-inert'
          : 'supported'
        : 'unsupported';
    case 'barMaxWidth':
      return value == null || isFiniteNumberInRange(value, 0, Number.POSITIVE_INFINITY)
        ? capability === 'timeseries-line'
          ? 'legacy-inert'
          : 'supported'
        : 'unsupported';
    case 'barWidthFactor':
      return value == null || isFiniteNumberInRange(value, 0, 1)
        ? capability === 'timeseries-line'
          ? 'legacy-inert'
          : 'supported'
        : 'unsupported';
    case 'drawStyle':
      if (value == null) {
        return 'supported';
      }
      if (capability === 'standalone-barchart') {
        return value === GraphDrawStyle.Bars ? 'supported' : 'unsupported';
      }
      return value === GraphDrawStyle.Line ||
        value === GraphDrawStyle.Points ||
        (capability === 'timeseries-bars' && value === GraphDrawStyle.Bars)
        ? 'supported'
        : 'unsupported';
    case 'fillBelowTo':
      return value == null || value === '' ? 'supported' : 'unsupported';
    case 'fillOpacity':
      return canNormalize(() => normalizeCompactFillOpacity(value)) ? 'supported' : 'unsupported';
    case 'gradientMode':
      return value == null || value === GraphGradientMode.None || value === GraphGradientMode.Opacity
        ? 'supported'
        : 'unsupported';
    case 'hideFrom':
      return value == null || isBooleanRecord(value, ['legend', 'tooltip', 'viz']) ? 'supported' : 'unsupported';
    case 'insertNulls':
      return canNormalize(() => normalizeCompactInsertNulls(value)) ? 'supported' : 'unsupported';
    case 'lineColor':
      return value == null || isValidColor(value) ? 'supported' : 'unsupported';
    case 'lineInterpolation':
      return value == null ||
        value === LineInterpolation.Linear ||
        value === LineInterpolation.StepBefore ||
        value === LineInterpolation.StepAfter
        ? 'supported'
        : 'unsupported';
    case 'lineStyle':
      return canNormalize(() => normalizeCompactLineStyle(value)) ? 'supported' : 'unsupported';
    case 'scaleDistribution':
      return value == null || isSupportedScaleDistribution(value) ? 'supported' : 'unsupported';
    case 'showPoints':
      return value == null ||
        value === VisibilityMode.Always ||
        value === VisibilityMode.Auto ||
        value === VisibilityMode.Never
        ? 'supported'
        : 'unsupported';
    case 'showValues':
      return value == null || typeof value === 'boolean' ? 'supported' : 'unsupported';
    case 'spanNulls':
      return value == null ||
        typeof value === 'boolean' ||
        value === -1 ||
        isFiniteNumberInRange(value, 0, Number.POSITIVE_INFINITY)
        ? 'supported'
        : 'unsupported';
    case 'stacking':
      return value == null || isSupportedStacking(value, capability !== 'timeseries-line')
        ? 'supported'
        : 'unsupported';
    case 'thresholdsStyle':
      return value == null || isSupportedThresholdStyle(value) ? 'supported' : 'unsupported';
    case 'transform':
      return value == null || value === GraphTransform.NegativeY || value === GraphTransform.Constant
        ? 'supported'
        : 'unsupported';
    // The legacy TimeSeries path does not pass these options to UPlotSeriesBuilder.
    case 'fillColor':
    case 'pointColor':
    case 'pointSymbol':
      return 'legacy-inert';
    default:
      return 'unsupported';
  }
}

export function parseCompactValueMatcher(options: unknown): CompactValueMatcher {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Compact native value matcher requires options');
  }

  const reducer = getReducer(getObjectProperty(options, 'reducer'));
  if (!reducer || !isCompactTimeSeriesReducerSupported(reducer)) {
    throw new Error('Compact native value matcher requires a supported reducer');
  }

  const configuredOperation = getObjectProperty(options, 'op');
  const operation = configuredOperation == null ? ComparisonOperation.EQ : getComparisonOperation(configuredOperation);
  if (!operation) {
    throw new Error('Compact native value matcher requires a supported comparison operation');
  }

  if (reducer === ReducerID.allIsNull || reducer === ReducerID.allIsZero) {
    return { reducer, operation };
  }

  const value = getObjectProperty(options, 'value');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Compact native value matcher requires a finite numeric comparison value');
  }
  return { reducer, operation, value };
}

export function isCompactFieldConfigSupported(
  fieldConfig: FieldConfigSource | undefined,
  capability: CompactPanelCapability = 'timeseries-line'
): boolean {
  return canNormalize(() => assertCompactFieldConfig(fieldConfig, capability));
}

export function assertCompactFieldConfig(
  fieldConfig: FieldConfigSource | undefined,
  capability: CompactPanelCapability = 'timeseries-line'
): void {
  if (!fieldConfig) {
    return;
  }
  if (fieldConfig.defaults.links?.length || fieldConfig.defaults.actions?.length) {
    throw new Error('Compact rendering does not support data links or actions');
  }
  assertCompactCustomConfig(fieldConfig.defaults.custom, capability);
  assertCompactColorReducer(fieldConfig.defaults.color);
  assertCompactBarColorSemantics(fieldConfig.defaults.color, fieldConfig.defaults.mappings, capability);

  for (const override of fieldConfig.overrides) {
    assertCompactMatcher(override.matcher.id, override.matcher.options);
    for (const property of override.properties) {
      if (property.id.startsWith('custom.')) {
        assertCompactCustomProperty(property.id.slice('custom.'.length), property.value, capability);
      } else if (property.id === FieldConfigProperty.Links || property.id === FieldConfigProperty.Actions) {
        throw new Error('Compact rendering does not support data links or actions');
      } else if (property.id === FieldConfigProperty.Color) {
        assertCompactColorReducer(property.value);
        assertCompactBarColorSemantics(property.value, undefined, capability);
      } else if (property.id === FieldConfigProperty.Mappings) {
        assertCompactBarColorSemantics(undefined, property.value, capability);
      }
    }
  }

  assertConsistentInsertNulls(fieldConfig);
}

export function isCompactReducerSupported(value: unknown): boolean {
  const reducer = getReducer(value);
  return reducer != null && isCompactTimeSeriesReducerSupported(reducer);
}

function assertCompactCustomConfig(custom: unknown, capability: CompactPanelCapability): void {
  if (custom == null) {
    return;
  }
  if (typeof custom !== 'object' || Array.isArray(custom)) {
    throw new Error('Compact rendering requires graph custom configuration to be an object');
  }
  for (const [property, value] of Object.entries(custom)) {
    assertCompactCustomProperty(property, value, capability);
  }
}

function assertCompactCustomProperty(property: string, value: unknown, capability: CompactPanelCapability): void {
  if (classifyCompactCustomProperty(property, value, capability) === 'unsupported') {
    throw new Error(`Compact rendering does not support custom.${property}`);
  }
}

function stripCompactInertProperties(custom: GraphFieldConfig | undefined, capability: CompactPanelCapability): void {
  if (!custom) {
    return;
  }
  for (const property of alwaysInertProperties) {
    delete custom[property];
  }
  if (capability === 'timeseries-line') {
    for (const property of lineOnlyInertProperties) {
      delete custom[property];
    }
  }
}

export function canonicalizeCompactCustomConfig(
  custom: GraphFieldConfig | undefined,
  capability: CompactPanelCapability = 'timeseries-line'
): GraphFieldConfig | undefined {
  assertCompactCustomConfig(custom, capability);
  if (!custom) {
    return undefined;
  }

  stripCompactInertProperties(custom, capability);
  if (getObjectProperty(custom.scaleDistribution, 'type') === 'sqrt') {
    custom.scaleDistribution = { type: ScaleDistribution.Linear };
  }
  if (custom.lineStyle == null) {
    delete custom.lineStyle;
    return Object.keys(custom).length === 0 ? undefined : custom;
  }

  const { dash } = normalizeCompactLineStyle(custom.lineStyle);
  const fill = custom.lineStyle.fill;
  custom.lineStyle = fill === 'solid' ? { fill } : { ...(fill === undefined ? {} : { fill }), dash: [...dash] };
  return custom;
}

export function normalizeCompactFillOpacity(value: unknown): number {
  if (value == null) {
    return 0;
  }
  if (!isFiniteNumberInRange(value, 0, 100)) {
    throw new Error('Compact rendering requires fill opacity between 0 and 100');
  }
  return value / 100;
}

export function normalizeCompactInsertNulls(value: unknown): number | undefined {
  if (value == null || value === false || value === 0) {
    return undefined;
  }
  if (!isFiniteNumberInRange(value, Number.MIN_VALUE, Infinity)) {
    throw new Error('Compact rendering requires insertNulls to be false or a positive finite number');
  }
  return value;
}

function isValidColor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && tinycolor(value).isValid();
}

function assertCompactMatcher(matcherId: string, matcherOptions: unknown): void {
  if (!supportedMatcherIds.has(matcherId)) {
    throw new Error(`Compact native field matcher ${matcherId} is unsupported`);
  }
  if (matcherId === FieldMatcherID.byValue) {
    parseCompactValueMatcher(matcherOptions);
  } else if (matcherId === FieldMatcherID.byRegexp) {
    assertCompactRegex(matcherOptions);
  } else if (matcherId === FieldMatcherID.byRegexpOrNames) {
    const pattern = getObjectProperty(matcherOptions, 'pattern');
    if (pattern != null) {
      assertCompactRegex(pattern);
    }
  }
}

function assertCompactRegex(value: unknown): void {
  if (typeof value !== 'string') {
    throw new Error('Compact native regular expression matcher requires a string pattern');
  }
  try {
    stringToJsRegex(value);
  } catch (error) {
    throw new Error('Compact native regular expression matcher requires a valid pattern', { cause: error });
  }
}

function assertCompactColorReducer(color: unknown): void {
  const reducer = getObjectProperty(color, 'reducer') ?? getObjectProperty(color, 'seriesBy');
  if (reducer != null && !isCompactReducerSupported(reducer)) {
    throw new Error('Compact rendering requires a supported color reducer');
  }
}

function assertCompactBarColorSemantics(color: unknown, mappings: unknown, capability: CompactPanelCapability): void {
  if (capability !== 'standalone-barchart') {
    return;
  }
  if (getObjectProperty(color, 'mode') === FieldColorModeId.Thresholds || containsMappedColor(mappings)) {
    throw new Error('Compact bar rendering does not support per-value colors');
  }
}

function containsMappedColor(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsMappedColor);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (getObjectProperty(value, 'color') != null) {
    return true;
  }
  return Object.values(value).some(containsMappedColor);
}

function assertConsistentInsertNulls(fieldConfig: FieldConfigSource): void {
  const defaultThreshold = normalizeCompactInsertNulls(getObjectProperty(fieldConfig.defaults.custom, 'insertNulls'));

  for (const override of fieldConfig.overrides) {
    for (const property of override.properties) {
      if (property.id === 'custom.insertNulls' && normalizeCompactInsertNulls(property.value) !== defaultThreshold) {
        throw new Error('Compact rendering requires one insertNulls threshold across a frame');
      }
    }
  }
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function normalizeCompactLineStyle(value: unknown): { dash: readonly number[]; cap: 'butt' | 'round' } {
  if (value == null) {
    return { dash: [], cap: 'butt' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Compact rendering requires a valid line style');
  }
  if (!hasOnlyProperties(value, ['dash', 'fill'])) {
    throw new Error('Compact rendering requires a supported line style');
  }

  const fill = Reflect.get(value, 'fill');
  if (fill === 'solid') {
    return { dash: [], cap: 'butt' };
  }
  if (fill !== undefined && fill !== 'dash' && fill !== 'dot' && fill !== 'square') {
    throw new Error('Compact rendering requires a supported line style');
  }

  const configuredDash = Reflect.get(value, 'dash');
  const dash = configuredDash == null ? [10, 10] : configuredDash;
  if (!Array.isArray(dash)) {
    throw new Error('Compact rendering requires line dash to be an array');
  }
  if (dash.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)) {
    throw new Error('Compact rendering requires finite non-negative line dash entries');
  }
  if (dash.length > 0 && dash.every((entry) => entry === 0)) {
    throw new Error('Compact rendering does not support an all-zero line dash');
  }
  return { dash, cap: fill === 'dot' ? 'round' : 'butt' };
}

function canNormalize(callback: () => unknown): boolean {
  try {
    callback();
    return true;
  } catch {
    return false;
  }
}

function getObjectProperty(value: unknown, property: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, property) : undefined;
}

function getReducer(value: unknown): ReducerID | undefined {
  return typeof value === 'string' ? reducerValues.find((candidate) => candidate === value) : undefined;
}

function getComparisonOperation(value: unknown): ComparisonOperation | undefined {
  return typeof value === 'string' ? comparisonOperationValues.find((candidate) => candidate === value) : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBooleanRecord(value: unknown, properties: readonly string[]): boolean {
  return (
    isRecord(value) &&
    hasOnlyProperties(value, properties) &&
    properties.every(
      (property) =>
        getObjectProperty(value, property) == null || typeof getObjectProperty(value, property) === 'boolean'
    )
  );
}

function isSupportedScaleDistribution(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyProperties(value, ['type', 'log', 'linearThreshold'])) {
    return false;
  }
  const type = getObjectProperty(value, 'type');
  if (type === 'sqrt') {
    return hasOnlyProperties(value, ['type']);
  }
  if (type !== ScaleDistribution.Linear && type !== ScaleDistribution.Log && type !== ScaleDistribution.Symlog) {
    return false;
  }
  const log = getObjectProperty(value, 'log');
  const linearThreshold = getObjectProperty(value, 'linearThreshold');
  return (
    (log == null || isFiniteNumberInRange(log, 1 + Number.EPSILON, Number.POSITIVE_INFINITY)) &&
    (linearThreshold == null || isFiniteNumberInRange(linearThreshold, Number.MIN_VALUE, Number.POSITIVE_INFINITY))
  );
}

function isSupportedStacking(value: unknown, allowPercent: boolean): boolean {
  return (
    isRecord(value) &&
    hasOnlyProperties(value, ['group', 'mode']) &&
    (getObjectProperty(value, 'mode') == null ||
      getObjectProperty(value, 'mode') === StackingMode.None ||
      getObjectProperty(value, 'mode') === StackingMode.Normal ||
      (allowPercent && getObjectProperty(value, 'mode') === StackingMode.Percent)) &&
    (getObjectProperty(value, 'group') == null || typeof getObjectProperty(value, 'group') === 'string')
  );
}

function isSupportedThresholdStyle(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyProperties(value, ['mode'])) {
    return false;
  }
  return thresholdStyleModes.has(getObjectProperty(value, 'mode'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyProperties(value: object, properties: readonly string[]): boolean {
  return Object.keys(value).every((property) => properties.includes(property));
}
