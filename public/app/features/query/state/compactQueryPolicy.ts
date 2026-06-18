import { CoreApp, DataQueryRequest, FieldConfigSource } from '@grafana/data';
import { VizOrientation } from '@grafana/schema';
import {
  isCompactFieldConfigSupported,
  isCompactReducerSupported,
} from 'app/core/components/GraphNG/compactCapabilities';

interface CompactDashboardQueryContext {
  app?: string;
  panelPluginId?: string;
  transformations?: readonly unknown[];
  isInspecting?: boolean;
  isTableView?: boolean;
  isPublicDashboard?: boolean;
  hasTimeComparison?: boolean;
  fieldConfig?: FieldConfigSource;
  legendCalcs?: unknown;
  panelOptions?: unknown;
}

interface CompactTimeSeriesPanelConfiguration {
  fieldConfig?: FieldConfigSource;
  legendCalcs?: unknown;
  panelOptions?: unknown;
}

export function isCompactTimeSeriesPanelConfigurationSupported({
  fieldConfig,
  legendCalcs,
  panelOptions,
}: CompactTimeSeriesPanelConfiguration): boolean {
  return (
    !hasUnsupportedLegendReducer(legendCalcs) &&
    !hasUnsupportedPanelOptions(panelOptions) &&
    isCompactFieldConfigSupported(fieldConfig)
  );
}

export function getPreferredDashboardQueryFormat({
  app,
  panelPluginId,
  transformations = [],
  isInspecting = false,
  isTableView = false,
  isPublicDashboard = false,
  hasTimeComparison = false,
  fieldConfig,
  legendCalcs,
  panelOptions,
}: CompactDashboardQueryContext): DataQueryRequest['preferredQueryResultFormat'] {
  if (
    app !== CoreApp.Dashboard ||
    panelPluginId !== 'timeseries' ||
    isInspecting ||
    isTableView ||
    isPublicDashboard ||
    hasTimeComparison ||
    transformations.some(isEnabledTransformation) ||
    !isCompactTimeSeriesPanelConfigurationSupported({ fieldConfig, legendCalcs, panelOptions })
  ) {
    return undefined;
  }

  return 'compact-v1';
}

function hasUnsupportedPanelOptions(options: unknown): boolean {
  if (options === undefined) {
    return false;
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return true;
  }

  const legend = getObjectProperty(options, 'legend');
  const hasMalformedLegend =
    legend !== undefined && (typeof legend !== 'object' || legend === null || Array.isArray(legend));
  return hasMalformedLegend || getObjectProperty(options, 'orientation') === VizOrientation.Vertical;
}

function getObjectProperty(value: unknown, property: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, property) : undefined;
}

function isEnabledTransformation(transformation: unknown): boolean {
  return (
    typeof transformation !== 'object' || transformation === null || Reflect.get(transformation, 'disabled') !== true
  );
}

function hasUnsupportedLegendReducer(reducers: unknown): boolean {
  if (reducers === undefined) {
    return false;
  }
  if (!Array.isArray(reducers)) {
    return true;
  }
  return reducers.some((reducer) => !isCompactReducerSupported(reducer));
}
