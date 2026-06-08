import * as React from 'react';
import type { JSX } from 'react';

import { DataFrameFieldIndex, DisplayValue } from '@grafana/data';
import { LegendDisplayMode, LegendPlacement, LineStyle } from '@grafana/schema';

export enum SeriesVisibilityChangeBehavior {
  Isolate,
  Hide,
}

export interface VizLegendBaseProps<T> {
  placement: LegendPlacement;
  className?: string;
  items: Array<VizLegendItem<T>>;
  itemSource?: VizLegendItemSource<T>;
  thresholdItems?: Array<VizLegendItem<T>>;
  mappingItems?: Array<VizLegendItem<T>>;
  seriesVisibilityChangeBehavior?: SeriesVisibilityChangeBehavior;
  onLabelClick?: (item: VizLegendItem<T>, event: React.MouseEvent<HTMLButtonElement>) => void;
  onSeriesVisibilityChange?: (item: VizLegendItem<T>, event: React.MouseEvent<HTMLButtonElement>) => void;
  itemRenderer?: (item: VizLegendItem<T>, index: number) => JSX.Element;
  onLabelMouseOver?: (
    item: VizLegendItem,
    event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>
  ) => void;
  onLabelMouseOut?: (
    item: VizLegendItem,
    event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>
  ) => void;
  readonly?: boolean;
  getItemDisplayValues?: (item: VizLegendItem<T>) => DisplayValue[];
  displayValueColumns?: Array<Pick<DisplayValue, 'title' | 'description'>>;
}

/**
 * Index-based legend data for high-cardinality visualizations. Items and
 * display values are created only for rows that are actually rendered.
 *
 * @internal
 */
export interface VizLegendItemSource<T = unknown> {
  readonly length: number;
  getItem(index: number): VizLegendItem<T>;
  getItemKey(index: number): React.Key;
  getItemsForYAxis?(yAxis: 1 | 2): VizLegendItemSource<T>;
  getDisplayValues?(index: number): DisplayValue[];
  getSortValue?(index: number, sortBy: string): number | string | undefined;
}

export interface VizLegendTableProps<T> extends VizLegendBaseProps<T> {
  sortBy?: string;
  sortDesc?: boolean;
  onToggleSort?: (sortBy: string) => void;
  isSortable?: boolean;
}

export interface LegendProps<T = any> extends VizLegendBaseProps<T>, VizLegendTableProps<T> {
  displayMode: LegendDisplayMode;
}

export interface VizLegendItem<T = any> {
  itemKey?: string;
  getItemKey?: () => string;
  label: string;
  color?: string;
  gradient?: string;
  yAxis: number;
  disabled?: boolean;
  // displayValues?: DisplayValue[];
  getDisplayValues?: () => DisplayValue[];
  fieldIndex?: DataFrameFieldIndex;
  fieldName?: string;
  data?: T;
  lineStyle?: LineStyle;
}
