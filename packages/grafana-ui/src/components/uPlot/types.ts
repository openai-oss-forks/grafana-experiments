import * as React from 'react';
import uPlot, { Options, AlignedData } from 'uplot';

import { UPlotConfigBuilder } from './config/UPlotConfigBuilder';

/**
 * @internal -- not a public API
 */
export const FIXED_UNIT = '__fixed';

export type PlotConfig = Pick<
  Options,
  'mode' | 'series' | 'scales' | 'axes' | 'cursor' | 'bands' | 'hooks' | 'select' | 'tzDate' | 'padding'
>;

export type FacetValues = any[];
export type FacetSeries = FacetValues[];
export type FacetedData = [_: null, ...series: FacetSeries];

export type CompactPlotValue = number | null | undefined;
export type CompactPlotScaleMode = 'all' | 'positive';
export type CompactPointVisitor = (index: number, value: CompactPlotValue, timestamp?: number) => void;

/** Reusable descriptor for a direct sequential scan of compact response storage. */
export interface CompactBufferScan {
  axisStart: number;
  axisStep: number;
  valuesByteOffset: number;
  presenceByteOffset: number;
  presenceByteLength: number;
  packedIndex: number;
  valueMultiplier: 1 | -1;
  missingValue: CompactPlotValue;
}

/** @internal Buffer-backed source used by the compact GraphNG renderer. */
export interface CompactPlotSource {
  readonly kind: 'compact-v1';
  readonly buffer: ArrayBuffer;
  readonly pointCount: number;
  readonly seriesCount: number;
  release(): void;
  xAt(index: number): number;
  closestXIndex(value: number, from: number, to: number): number;
  barWidthValueAt?(seriesIndex: number, index: number): CompactPlotValue;
  cursorValueAt(seriesIndex: number, index: number): CompactPlotValue;
  yAt(seriesIndex: number, index: number): CompactPlotValue;
  scan(seriesIndex: number, from: number, to: number, visitor: CompactPointVisitor): void;
  prepareBufferScan(seriesIndex: number, from: number, target: CompactBufferScan): boolean;
  extent(
    seriesIndex: number,
    from: number,
    to: number,
    mode?: CompactPlotScaleMode
  ): [min: number | null, max: number | null];
  nearestPresent(seriesIndex: number, index: number, bias: -1 | 0 | 1): number | null;
}

export type PlotData = AlignedData | FacetedData | CompactPlotSource;

export function isCompactPlotSource(data: PlotData): data is CompactPlotSource {
  return !Array.isArray(data) && data.kind === 'compact-v1';
}

export interface PlotProps {
  data: PlotData;
  width: number;
  height: number;
  config: UPlotConfigBuilder;
  children?: React.ReactNode;
  // Reference to uPlot instance
  plotRef?: (u: uPlot | null) => void;
}

export abstract class PlotConfigBuilder<P, T> {
  constructor(public props: P) {}
  abstract getConfig(): T;
}

/**
 * @alpha
 */
export type PlotTooltipInterpolator = (
  updateActiveSeriesIdx: (sIdx: number | null) => void,
  updateActiveDatapointIdx: (dIdx: number | null) => void,
  updateTooltipPosition: (clear?: boolean) => void,
  u: uPlot
) => void;

export interface PlotSelection {
  min: number;
  max: number;

  // selection bounding box, relative to canvas
  bbox: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
}
