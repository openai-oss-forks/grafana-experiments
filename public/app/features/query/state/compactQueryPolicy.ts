import { CoreApp, DataQueryRequest, FieldConfigSource } from '@grafana/data';
import { config } from '@grafana/runtime';
import { VizOrientation } from '@grafana/schema';
import {
  isCompactFieldConfigSupported,
  isCompactReducerSupported,
} from 'app/core/components/GraphNG/compactCapabilities';

interface CompactDashboardQueryContext {
  app?: string;
  panelPluginId?: string;
  transformations?: readonly unknown[];
  isEditing?: boolean;
  isInspecting?: boolean;
  isPublicDashboard?: boolean;
  hasTimeComparison?: boolean;
  fieldConfig?: FieldConfigSource;
  legendCalcs?: readonly string[];
  panelOptions?: unknown;
}

export function getPreferredDashboardQueryFormat({
  app,
  panelPluginId,
  transformations = [],
  isEditing = false,
  isInspecting = false,
  isPublicDashboard = false,
  hasTimeComparison = false,
  fieldConfig,
  legendCalcs = [],
  panelOptions,
}: CompactDashboardQueryContext): DataQueryRequest['preferredQueryResultFormat'] {
  if (
    config.featureToggles.queryServiceRewrite ||
    app !== CoreApp.Dashboard ||
    panelPluginId !== 'timeseries' ||
    isEditing ||
    isInspecting ||
    isPublicDashboard ||
    hasTimeComparison ||
    transformations.some(isEnabledTransformation) ||
    hasUnsupportedLegendReducer(legendCalcs) ||
    hasUnsupportedPanelOptions(panelOptions) ||
    !isCompactFieldConfigSupported(fieldConfig)
  ) {
    return undefined;
  }

  return 'compact-v1';
}

function hasUnsupportedPanelOptions(options: unknown): boolean {
  return getObjectProperty(options, 'orientation') === VizOrientation.Vertical;
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
