import {
  CoreApp,
  DataQueryRequest,
  FieldConfigProperty,
  FieldConfigSource,
  FieldMatcherID,
  FieldType,
} from '@grafana/data';
import {
  BarAlignment,
  GraphDrawStyle,
  GraphFieldConfig,
  StackingMode,
  VisibilityMode,
  VizOrientation,
} from '@grafana/schema';
import {
  CompactPanelCapability,
  isCompactFieldConfigSupported,
  isCompactReducerSupported,
} from 'app/core/components/GraphNG/compactCapabilities';

interface CompactDashboardQueryContext {
  app?: string;
  panelPluginId?: string;
  transformations?: readonly unknown[];
  isInspecting?: boolean;
  isPublicDashboard?: boolean;
  hasTimeComparison?: boolean;
  fieldConfig?: FieldConfigSource;
  legendCalcs?: readonly string[];
  panelOptions?: unknown;
}

interface CompactTimeSeriesPanelConfiguration {
  fieldConfig?: FieldConfigSource;
  legendCalcs?: readonly string[];
  panelOptions?: unknown;
}

const standaloneBarStackGroup = '__compact_barchart';
const standaloneBarPanelOwnedFieldProperties = new Set([
  'custom.barAlignment',
  'custom.barMaxWidth',
  'custom.barWidthFactor',
  'custom.drawStyle',
  'custom.showPoints',
  'custom.showValues',
  'custom.stacking',
]);

export function isCompactTimeSeriesPanelConfigurationSupported({
  fieldConfig,
  legendCalcs = [],
  panelOptions,
}: CompactTimeSeriesPanelConfiguration): boolean {
  const capability = getCompactTimeSeriesCapability(fieldConfig);
  return (
    !hasUnsupportedLegendReducer(legendCalcs) &&
    !hasUnsupportedTimeSeriesPanelOptions(panelOptions) &&
    !hasUnsupportedTimeSeriesStyleCombination(fieldConfig) &&
    isCompactFieldConfigSupported(fieldConfig, capability)
  );
}

export function getCompactTimeSeriesCapability(fieldConfig?: FieldConfigSource): CompactPanelCapability {
  const hasBars = getPossibleTimeSeriesStyles(fieldConfig).some((style) => style.drawStyle === GraphDrawStyle.Bars);
  return hasBars ? 'timeseries-bars' : 'timeseries-line';
}

interface TimeSeriesStyleState {
  drawStyle: unknown;
  stackingMode: unknown;
}

function getPossibleTimeSeriesStyles(fieldConfig: FieldConfigSource | undefined): TimeSeriesStyleState[] {
  const defaults = getObjectProperty(fieldConfig, 'defaults');
  const custom = getObjectProperty(defaults, 'custom');
  let states: TimeSeriesStyleState[] = [
    {
      drawStyle: getObjectProperty(custom, 'drawStyle') ?? GraphDrawStyle.Line,
      stackingMode: getObjectProperty(getObjectProperty(custom, 'stacking'), 'mode') ?? StackingMode.None,
    },
  ];
  const overrides = getObjectProperty(fieldConfig, 'overrides');
  if (!Array.isArray(overrides)) {
    return states;
  }

  for (const override of overrides) {
    const properties = getObjectProperty(override, 'properties');
    if (!Array.isArray(properties)) {
      continue;
    }
    let drawStyle: unknown;
    let stackingMode: unknown;
    let changesDrawStyle = false;
    let changesStacking = false;
    for (const property of properties) {
      const id = getObjectProperty(property, 'id');
      if (id === 'custom.drawStyle') {
        drawStyle = getObjectProperty(property, 'value');
        changesDrawStyle = true;
      } else if (id === 'custom.stacking') {
        stackingMode = getObjectProperty(getObjectProperty(property, 'value'), 'mode') ?? StackingMode.None;
        changesStacking = true;
      }
    }
    if (!changesDrawStyle && !changesStacking) {
      continue;
    }

    const matchedStates = states.map((state) => ({
      drawStyle: changesDrawStyle ? drawStyle : state.drawStyle,
      stackingMode: changesStacking ? stackingMode : state.stackingMode,
    }));
    for (const matched of matchedStates) {
      if (
        !states.some((state) => state.drawStyle === matched.drawStyle && state.stackingMode === matched.stackingMode)
      ) {
        states.push(matched);
      }
    }
  }
  return states;
}

function hasUnsupportedTimeSeriesStyleCombination(fieldConfig: FieldConfigSource | undefined): boolean {
  return getPossibleTimeSeriesStyles(fieldConfig).some(
    (style) => style.stackingMode === StackingMode.Percent && style.drawStyle !== GraphDrawStyle.Bars
  );
}

export function isCompactStandaloneBarChartConfigurationSupported({
  fieldConfig,
  legendCalcs = [],
  panelOptions,
}: CompactTimeSeriesPanelConfiguration): boolean {
  const finalFieldConfig = fieldConfig ? buildCompactStandaloneBarFieldConfig(fieldConfig, panelOptions) : undefined;
  return (
    !hasUnsupportedLegendReducer(legendCalcs) &&
    isSupportedStandaloneBarChartOptions(panelOptions) &&
    isCompactFieldConfigSupported(finalFieldConfig, 'standalone-barchart') &&
    !hasUnsupportedStandaloneCategoryFieldConfig(fieldConfig)
  );
}

export function buildCompactStandaloneBarFieldConfig(
  fieldConfig: FieldConfigSource,
  panelOptions: unknown
): FieldConfigSource<GraphFieldConfig> {
  const defaults = getObjectProperty(fieldConfig, 'defaults');
  const overrides = getObjectProperty(fieldConfig, 'overrides');
  if (
    typeof defaults !== 'object' ||
    defaults === null ||
    Array.isArray(defaults) ||
    !Array.isArray(overrides) ||
    overrides.some((override) => {
      const properties = getObjectProperty(override, 'properties');
      return (
        !Array.isArray(properties) ||
        properties.some((property) => typeof property !== 'object' || property === null || Array.isArray(property))
      );
    })
  ) {
    return fieldConfig;
  }

  const custom = fieldConfig.defaults.custom;
  if (custom != null && (typeof custom !== 'object' || Array.isArray(custom))) {
    return fieldConfig;
  }

  const barWidth = getObjectProperty(panelOptions, 'barWidth');
  const stacking = getObjectProperty(panelOptions, 'stacking');
  const showValue = getObjectProperty(panelOptions, 'showValue');
  return {
    defaults: {
      ...fieldConfig.defaults,
      custom: {
        ...custom,
        drawStyle: GraphDrawStyle.Bars,
        showPoints: VisibilityMode.Never,
        showValues: showValue !== VisibilityMode.Never,
        barAlignment: BarAlignment.Center,
        barWidthFactor: typeof barWidth === 'number' ? barWidth : undefined,
        barMaxWidth: 200,
        stacking: {
          mode: isStandaloneBarStacking(stacking) ? stacking : StackingMode.None,
          group: standaloneBarStackGroup,
        },
        axisSoftMin: custom?.axisSoftMin ?? 0,
        axisSoftMax: custom?.axisSoftMax ?? 0,
      },
    },
    overrides: fieldConfig.overrides.map((override) => ({
      ...override,
      matcher: { ...override.matcher },
      properties: override.properties
        .filter((property) => !standaloneBarPanelOwnedFieldProperties.has(property.id))
        .map((property) => ({ ...property })),
    })),
  };
}

function hasUnsupportedStandaloneCategoryFieldConfig(fieldConfig: FieldConfigSource | undefined): boolean {
  if (!fieldConfig) {
    return false;
  }

  const defaults = getObjectProperty(fieldConfig, 'defaults');
  const defaultUnit = getObjectProperty(defaults, 'unit');
  if (defaultUnit != null && (typeof defaultUnit !== 'string' || defaultUnit.startsWith('time:'))) {
    return true;
  }

  const overrides = getObjectProperty(fieldConfig, 'overrides');
  if (!Array.isArray(overrides)) {
    return false;
  }
  return overrides.some((override) => {
    const matcher = getObjectProperty(override, 'matcher');
    const matcherId = getObjectProperty(matcher, 'id');
    if (typeof matcherId === 'string' && isDefinitelyNumericMatcher(matcherId, getObjectProperty(matcher, 'options'))) {
      return false;
    }
    const properties = getObjectProperty(override, 'properties');
    return (
      Array.isArray(properties) &&
      properties.some((property) => {
        const propertyId = getObjectProperty(property, 'id');
        if (propertyId === 'custom.axisLabel' || propertyId === 'custom.axisPlacement') {
          return true;
        }
        if (propertyId !== FieldConfigProperty.Unit) {
          return false;
        }
        const value = getObjectProperty(property, 'value');
        return value != null && (typeof value !== 'string' || value.startsWith('time:'));
      })
    );
  });
}

function isDefinitelyNumericMatcher(matcherId: string, matcherOptions: unknown): boolean {
  if (matcherId === FieldMatcherID.numeric) {
    return true;
  }
  if (matcherId === FieldMatcherID.byType) {
    return matcherOptions === FieldType.number;
  }
  if (matcherId === FieldMatcherID.byTypes) {
    const types = matcherOptions instanceof Set ? Array.from(matcherOptions) : matcherOptions;
    return Array.isArray(types) && types.length > 0 && types.every((type) => type === FieldType.number);
  }
  return false;
}

export function getPreferredDashboardQueryFormat({
  app,
  panelPluginId,
  transformations = [],
  isInspecting = false,
  isPublicDashboard = false,
  hasTimeComparison = false,
  fieldConfig,
  legendCalcs = [],
  panelOptions,
}: CompactDashboardQueryContext): DataQueryRequest['preferredQueryResultFormat'] {
  if (
    app !== CoreApp.Dashboard ||
    isInspecting ||
    isPublicDashboard ||
    hasTimeComparison ||
    transformations.some(isEnabledTransformation)
  ) {
    return undefined;
  }

  const configurationSupported =
    panelPluginId === 'timeseries'
      ? isCompactTimeSeriesPanelConfigurationSupported({ fieldConfig, legendCalcs, panelOptions })
      : panelPluginId === 'barchart'
        ? isCompactStandaloneBarChartConfigurationSupported({ fieldConfig, legendCalcs, panelOptions })
        : false;

  if (!configurationSupported) {
    return undefined;
  }

  return 'compact-v1';
}

function hasUnsupportedTimeSeriesPanelOptions(options: unknown): boolean {
  return getObjectProperty(options, 'orientation') === VizOrientation.Vertical;
}

function isSupportedStandaloneBarChartOptions(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) {
    return false;
  }

  const supportedProperties = new Set([
    'barRadius',
    'barWidth',
    'colorByField',
    'fullHighlight',
    'groupWidth',
    'legend',
    'orientation',
    'showValue',
    'stacking',
    'text',
    'tooltip',
    'xField',
    'xTickLabelMaxLength',
    'xTickLabelRotation',
    'xTickLabelSpacing',
  ]);
  if (Array.isArray(options) || Object.keys(options).some((property) => !supportedProperties.has(property))) {
    return false;
  }

  const xField = getObjectProperty(options, 'xField');
  const colorByField = getObjectProperty(options, 'colorByField');
  const orientation = getObjectProperty(options, 'orientation');
  const stacking = getObjectProperty(options, 'stacking');
  const showValue = getObjectProperty(options, 'showValue');
  const text = getObjectProperty(options, 'text');

  return (
    (xField == null || xField === '') &&
    (colorByField == null || colorByField === '') &&
    (orientation == null ||
      orientation === VizOrientation.Auto ||
      orientation === VizOrientation.Horizontal ||
      orientation === VizOrientation.Vertical) &&
    (stacking == null || isStandaloneBarStacking(stacking)) &&
    (showValue == null ||
      showValue === VisibilityMode.Auto ||
      showValue === VisibilityMode.Always ||
      showValue === VisibilityMode.Never) &&
    isOptionalFiniteRange(getObjectProperty(options, 'groupWidth'), 0, 1) &&
    isOptionalFiniteRange(getObjectProperty(options, 'barWidth'), 0, 1) &&
    isOptionalFiniteRange(getObjectProperty(options, 'barRadius'), 0, 0.5) &&
    isOptionalFiniteRange(getObjectProperty(options, 'xTickLabelRotation'), -90, 90) &&
    (getObjectProperty(options, 'xTickLabelMaxLength') == null ||
      getObjectProperty(options, 'xTickLabelMaxLength') === 0) &&
    isOptionalFiniteRange(
      getObjectProperty(options, 'xTickLabelSpacing'),
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY
    ) &&
    (text == null ||
      (typeof text === 'object' &&
        !Array.isArray(text) &&
        isOptionalFiniteRange(getObjectProperty(text, 'valueSize'), 1, Number.POSITIVE_INFINITY))) &&
    isOptionalBoolean(getObjectProperty(options, 'fullHighlight'))
  );
}

function isStandaloneBarStacking(value: unknown): value is StackingMode {
  return value === StackingMode.None || value === StackingMode.Normal || value === StackingMode.Percent;
}

function isOptionalFiniteRange(value: unknown, minimum: number, maximum: number): boolean {
  return value == null || (typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum);
}

function isOptionalBoolean(value: unknown): boolean {
  return value == null || typeof value === 'boolean';
}

function getObjectProperty(value: unknown, property: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, property) : undefined;
}

function isEnabledTransformation(transformation: unknown): boolean {
  return (
    typeof transformation !== 'object' || transformation === null || Reflect.get(transformation, 'disabled') !== true
  );
}

function hasUnsupportedLegendReducer(reducers: readonly string[]): boolean {
  return reducers.some((reducer) => !isCompactReducerSupported(reducer));
}
