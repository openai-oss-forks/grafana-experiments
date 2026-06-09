import {
  DataLinkPostProcessor,
  FieldConfigOptionsRegistry,
  FieldConfigSource,
  GrafanaTheme2,
  InterpolateFunction,
  TimeZone,
} from '@grafana/data';
import { GraphFieldConfig } from '@grafana/schema';

export interface CompactFieldConfigOptions {
  fieldConfig: FieldConfigSource<GraphFieldConfig>;
  fieldConfigRegistry: FieldConfigOptionsRegistry;
  replaceVariables: InterpolateFunction;
  theme: GrafanaTheme2;
  timeZone?: TimeZone;
  dataLinkPostProcessor?: DataLinkPostProcessor;
  cursorMode?: 'single' | 'multi' | 'none';
  highlightSeriesOnHover?: boolean;
}
