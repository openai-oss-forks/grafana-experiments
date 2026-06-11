import uPlot from 'uplot';

import { ScaleDirection, ScaleDistribution, ScaleOrientation } from '@grafana/schema';

import type { UPlotConfigBuilder } from './config/UPlotConfigBuilder';
import type { CompactBufferScan, CompactPlotScaleMode, CompactPlotSource, CompactPlotValue } from './types';

export type CompactIndexColumn = Uint8Array | Uint16Array | Uint32Array;

export const enum CompactSeriesFlag {
  PathMask = 0b11,
  Linear = 0,
  StepBefore = 1,
  StepAfter = 2,
  Spline = 3,
  Points = 1 << 2,
  Stack = 1 << 4,
  AutoPoints = 1 << 5,
  PercentStack = 1 << 6,
  DrawLine = 1 << 7,
}

export interface CompactRenderColumns {
  readonly styleIds: CompactIndexColumn;
  readonly scaleIds: CompactIndexColumn;
  readonly flags: CompactIndexColumn;
  readonly visibility: Uint8Array;
  /** Zero means unstacked. Non-zero IDs must be dense and no greater than stackGroupCount. */
  readonly stackGroupIds?: CompactIndexColumn;
}

export interface CompactStyleRecord {
  readonly stroke: string;
  readonly fill?: string | null;
  readonly areaFill?: string | null;
  readonly areaGradient?: readonly [string, string] | null;
  readonly lineWidth?: number;
  readonly pointSize?: number;
  readonly pointSpace?: number;
  readonly pointLineWidth?: number;
  readonly alpha?: number;
  readonly lineDash?: number[];
  readonly lineCap?: 'butt' | 'round';
  readonly disconnectThreshold?: number;
  readonly spanNullsThreshold?: number;
  readonly showValues?: boolean;
}

export interface CompactScaleRecord {
  readonly key: string;
  readonly mode?: CompactPlotScaleMode;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly softMin?: number | null;
  readonly softMax?: number | null;
  readonly distribution?: ScaleDistribution;
  readonly log?: number;
  readonly linearThreshold?: number;
  readonly centeredZero?: boolean;
  readonly decimals?: number;
  readonly padMinBy?: number;
  readonly padMaxBy?: number;
  readonly axisColor?: string;
}

export interface CompactRenderSource extends CompactPlotSource {
  readonly columns: CompactRenderColumns;
  readonly styles: readonly CompactStyleRecord[];
  readonly scales: readonly CompactScaleRecord[];
  readonly stackGroupCount: number;
  readonly cursorMode: 'single' | 'multi' | 'none';
  readonly highlightSeriesOnHover?: boolean;
  seriesIdentityAt?(seriesIndex: number): string;
  seriesIdentityHashAt?(seriesIndex: number): number;
  formatValueAt?(seriesIndex: number, index: number, value: number): string;
  readonly valueColor?: string;
  readonly valueFontFamily?: string;
  visibilityState: CompactVisibilityState;
}

export interface CompactVisibilityOverride {
  readonly identity: string;
  visibility: number;
}

export interface CompactVisibilityState {
  globalVisibility?: number;
  readonly overrides: Map<number, CompactVisibilityOverride[]>;
}

const releasedBuffer = new ArrayBuffer(0);
const releasedSource: CompactRenderSource = {
  kind: 'compact-v1',
  buffer: releasedBuffer,
  pointCount: 0,
  seriesCount: 0,
  columns: {
    styleIds: new Uint8Array(0),
    scaleIds: new Uint8Array(0),
    flags: new Uint8Array(0),
    visibility: new Uint8Array(0),
  },
  styles: [],
  scales: [],
  stackGroupCount: 0,
  cursorMode: 'none',
  visibilityState: { overrides: new Map() },
  release: () => {},
  xAt: () => {
    throw new Error('Compact renderer has been destroyed');
  },
  closestXIndex: () => {
    throw new Error('Compact renderer has been destroyed');
  },
  cursorValueAt: () => {
    throw new Error('Compact renderer has been destroyed');
  },
  yAt: () => {
    throw new Error('Compact renderer has been destroyed');
  },
  scan: () => {
    throw new Error('Compact renderer has been destroyed');
  },
  prepareBufferScan: () => {
    throw new Error('Compact renderer has been destroyed');
  },
  extent: () => {
    throw new Error('Compact renderer has been destroyed');
  },
  nearestPresent: () => {
    throw new Error('Compact renderer has been destroyed');
  },
};

export interface CompactCursorSnapshot {
  readonly source: CompactRenderSource;
  readonly seriesCount: number;
  readonly cursorIndex: number;
  readonly timestamp: number;
  readonly revision: number;
  valueAt(seriesIndex: number): CompactPlotValue;
  dataIndexAt(seriesIndex: number): number;
}

interface MutableCompactCursorSnapshot extends CompactCursorSnapshot {
  source: CompactRenderSource;
  seriesCount: number;
  cursorIndex: number;
  timestamp: number;
  revision: number;
}

const enum CursorValueState {
  Undefined,
  Null,
  Number,
}

const enum ScanOperation {
  None,
  Area,
  GapClip,
  Line,
  Points,
  StackExtent,
  StackPresence,
  StackCommit,
  ValueLabel,
  DecimatedLine,
}

const controllers = new WeakMap<CompactRenderSource, CompactRenderController>();
const PROGRESSIVE_SAMPLE_THRESHOLD = 1_000_000;
const PROGRESSIVE_POINT_BUDGET = 32_000;
const hoverStageProbe = getCompactHoverStageProbe();

export function getCompactHoverStageProbe():
  | { record(stage: string, sample: Record<string, number | boolean>): void }
  | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const candidate: unknown = Reflect.get(window, '__compactHoverStageProbe');
  if (
    candidate == null ||
    typeof candidate !== 'object' ||
    !('record' in candidate) ||
    typeof candidate.record !== 'function'
  ) {
    return undefined;
  }
  const record = candidate.record;
  return {
    record: (stage, sample) => Reflect.apply(record, candidate, [stage, sample]),
  };
}

export function isCompactRenderSource(
  source: uPlot.CompactPlotSource | CompactPlotSource
): source is CompactRenderSource {
  return (
    'columns' in source &&
    'styles' in source &&
    'scales' in source &&
    'cursorValueAt' in source &&
    typeof source.cursorValueAt === 'function'
  );
}

/**
 * Registers the compact renderer and the source's shared value scales before the builder is materialized.
 * The source continues to own every timestamp and sample.
 */
export function installCompactRenderer(
  builder: UPlotConfigBuilder,
  source: CompactRenderSource
): CompactRenderController {
  const controller = new CompactRenderController(source);
  for (const scale of source.scales) {
    builder.addScale({
      scaleKey: scale.key,
      isTime: false,
      orientation: ScaleOrientation.Vertical,
      direction: ScaleDirection.Up,
      min: scale.min,
      max: scale.max,
      softMin: scale.softMin,
      softMax: scale.softMax,
      distribution: scale.distribution,
      log: scale.log,
      linearThreshold: scale.linearThreshold,
      centeredZero: scale.centeredZero,
      decimals: scale.decimals,
      padMinBy: scale.padMinBy,
      padMaxBy: scale.padMaxBy,
    });
  }
  controllers.set(source, controller);
  return controller;
}

export function getCompactRenderController(source: CompactRenderSource): CompactRenderController {
  let controller = controllers.get(source);
  if (!controller) {
    controller = new CompactRenderController(source);
    controllers.set(source, controller);
  }
  return controller;
}

/**
 * uPlot integration point for binary-native rendering. All retained state is constant-sized or keyed by
 * unique scales/styles/stack groups rather than by samples or series.
 */
export class CompactRenderController implements uPlot.CompactRenderController {
  private source: CompactRenderSource;
  private bufferView: DataView;
  private bufferBytes: Uint8Array;
  private focusedSeries = -1;
  private requestedFocusedSeries = -1;
  private visibleSeriesCount = 0;
  private renderedPlot: uPlot | null = null;
  private focusCanvas: HTMLCanvasElement | null = null;
  private focusContext: CanvasRenderingContext2D | null = null;
  private focusScanFrom = 0;
  private focusScanTo = 0;
  private focusVisibleFrom = 0;
  private focusVisibleTo = 0;
  private stackScratch = new Float64Array(0);
  private stackPresence = new Uint8Array(0);
  private stackAreaIndexes = new Int32Array(0);
  private stackAreaLength = 0;
  private cursorStacks = new Float64Array(0);
  private cursorStackIndexes = new Int32Array(0);
  private cursorSnapshotValues = new Float64Array(0);
  private cursorSnapshotStates = new Uint8Array(0);
  private cursorSnapshotDataIndexes: Int32Array | null = null;
  private cursorSnapshotIndex = -1;
  private cursorSnapshotMouseX = Number.NaN;
  private readonly cursorSnapshot: MutableCompactCursorSnapshot;
  private gradientCache: Array<CanvasGradient | undefined> = [];
  private stackFrom = 0;
  private stackPointCount = 0;
  private progressiveGeneration = 0;
  private progressiveTimer: number | undefined;
  private resolveProgressiveDraw: ((completed: boolean) => void) | undefined;

  private operation = ScanOperation.None;
  private plot: uPlot | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private seriesIndex = 0;
  private scaleKey = '';
  private flags = 0;
  private pathStarted = false;
  private hasPath = false;
  private previousX = 0;
  private previousY = 0;
  private previousTimestamp = Number.NaN;
  private fillBaselineY = 0;
  private gapClipStartX = 0;
  private gapStartX: number | null = null;
  private gapPreviousX: number | null = null;
  private gapBoundaryOffset = 0;
  private hasGapClip = false;
  private clipAreaGaps = false;
  private clipLineGaps = false;
  private hasPrevious = false;
  private extentMin: number | null = null;
  private extentMax: number | null = null;
  private extentMode: CompactPlotScaleMode = 'all';
  private decimatedX = 0;
  private decimatedMin: number | null = null;
  private decimatedMax: number | null = null;
  private decimatedIn = 0;
  private decimatedOut = 0;
  private decimatedInIndex = 0;
  private decimatedOutIndex = 0;
  private decimatedMinIndex = 0;
  private decimatedMaxIndex = 0;
  private decimatedNextXValue = Number.NaN;
  private decimatedPixelDirection = 1;
  private readonly bufferScan: CompactBufferScan = {
    axisStart: 0,
    axisStep: 0,
    valuesByteOffset: 0,
    presenceByteOffset: 0,
    presenceByteLength: 0,
    packedIndex: 0,
    valueMultiplier: 1,
    missingValue: null,
  };

  private readonly cursorState: uPlot.CompactCursorState = {
    hasPoint: false,
    seriesIndex: -1,
    dataIndex: -1,
    distance: Number.POSITIVE_INFINITY,
    left: -10,
    top: -10,
    size: 0,
    fill: 'transparent',
    stroke: 'transparent',
  };

  private readonly visitPoint = (index: number, value: CompactPlotValue, timestamp?: number): void => {
    const xValue = timestamp ?? this.source.xAt(index);
    switch (this.operation) {
      case ScanOperation.Area:
        this.visitArea(index, value, xValue);
        break;
      case ScanOperation.GapClip:
        this.visitGapClip(value, xValue);
        break;
      case ScanOperation.Line:
        this.visitLine(index, value, xValue);
        break;
      case ScanOperation.Points:
        this.visitPointMarker(index, value, xValue);
        break;
      case ScanOperation.StackExtent:
        this.visitStackExtent(index, value);
        break;
      case ScanOperation.StackPresence:
        this.visitStackPresence(index, value);
        break;
      case ScanOperation.StackCommit:
        this.visitStackCommit(index, value);
        break;
      case ScanOperation.ValueLabel:
        this.visitValueLabel(index, value, xValue);
        break;
      case ScanOperation.DecimatedLine:
        this.visitDecimatedLine(index, value, xValue);
        break;
    }
  };

  constructor(source: CompactRenderSource) {
    validateSource(source);
    this.source = source;
    this.bufferView = new DataView(source.buffer);
    this.bufferBytes = new Uint8Array(source.buffer);
    this.cursorSnapshot = {
      source,
      seriesCount: source.seriesCount,
      cursorIndex: -1,
      timestamp: Number.NaN,
      revision: 0,
      valueAt: (seriesIndex) => this.readCursorSnapshotValue(seriesIndex),
      dataIndexAt: (seriesIndex) => this.readCursorSnapshotDataIndex(seriesIndex),
    };
    this.applyVisibilityState(source);
    this.ensureStackCursorScratch();
  }

  replaceSource(oldSource: uPlot.CompactPlotSource, nextSource: uPlot.CompactPlotSource): void {
    if (oldSource !== this.source) {
      throw new Error('Compact renderer source ownership mismatch');
    }
    if (!isCompactRenderSource(nextSource)) {
      throw new Error('Compact renderer requires typed render columns');
    }
    validateCompatibleSource(this.source, nextSource);
    this.cancelProgressiveDraw();
    const previousSource = this.source;
    controllers.delete(previousSource);
    this.source = nextSource;
    this.bufferView = new DataView(nextSource.buffer);
    this.bufferBytes = new Uint8Array(nextSource.buffer);
    this.cursorSnapshot.source = nextSource;
    this.cursorSnapshot.seriesCount = nextSource.seriesCount;
    this.invalidateCursorSnapshot();
    copyVisibilityState(previousSource.visibilityState, nextSource.visibilityState);
    this.applyVisibilityState(nextSource);
    this.focusedSeries = -1;
    this.requestedFocusedSeries = -1;
    this.removeFocusOverlay();
    this.stackScratch = new Float64Array(0);
    this.stackPresence = new Uint8Array(0);
    this.stackAreaIndexes = new Int32Array(0);
    this.stackAreaLength = 0;
    this.cursorSnapshotValues = new Float64Array(0);
    this.cursorSnapshotStates = new Uint8Array(0);
    this.cursorSnapshotDataIndexes = null;
    this.gradientCache.length = 0;
    this.ensureStackCursorScratch();
    controllers.set(nextSource, this);
  }

  destroy(source: uPlot.CompactPlotSource): void {
    if (source !== this.source) {
      throw new Error('Compact renderer destroyed with a foreign source');
    }
    this.cancelProgressiveDraw();
    this.removeFocusOverlay();
    this.renderedPlot = null;
    this.plot = null;
    this.context = null;
    this.stackScratch = new Float64Array(0);
    this.stackPresence = new Uint8Array(0);
    this.stackAreaIndexes = new Int32Array(0);
    this.stackAreaLength = 0;
    this.cursorStacks = new Float64Array(0);
    this.cursorStackIndexes = new Int32Array(0);
    this.cursorSnapshotValues = new Float64Array(0);
    this.cursorSnapshotStates = new Uint8Array(0);
    this.cursorSnapshotDataIndexes = null;
    this.invalidateCursorSnapshot();
    this.gradientCache.length = 0;
    controllers.delete(this.source);
    this.source = releasedSource;
    this.bufferView = new DataView(releasedBuffer);
    this.bufferBytes = new Uint8Array(releasedBuffer);
    this.cursorSnapshot.source = releasedSource;
    this.cursorSnapshot.seriesCount = 0;
    this.focusedSeries = -1;
    this.requestedFocusedSeries = -1;
  }

  extent(_plot: uPlot, scaleKey: string, from: number, to: number): [number | null, number | null] {
    if (this.source.pointCount === 0 || from > to) {
      return [null, null];
    }
    const scaleId = this.findScaleId(scaleKey);
    if (scaleId < 0) {
      return [null, null];
    }

    let min: number | null = null;
    let max: number | null = null;
    let hasStackedSeries = false;
    const mode = this.source.scales[scaleId].mode ?? 'all';

    for (let series = 0; series < this.source.seriesCount; series++) {
      if (!this.isVisible(series) || this.source.columns.scaleIds[series] !== scaleId) {
        continue;
      }
      if ((this.source.columns.flags[series] & CompactSeriesFlag.Stack) !== 0) {
        hasStackedSeries = true;
        continue;
      }
      const seriesExtent = this.source.extent(series, from, to, mode);
      if (seriesExtent[0] != null) {
        min = min == null ? seriesExtent[0] : Math.min(min, seriesExtent[0]);
        max = max == null ? seriesExtent[1] : Math.max(max, seriesExtent[1]!);
      }
    }

    if (hasStackedSeries) {
      this.prepareStackScratch(from, to);
      this.operation = ScanOperation.StackExtent;
      this.extentMin = null;
      this.extentMax = null;
      this.extentMode = mode;
      for (let series = 0; series < this.source.seriesCount; series++) {
        if (
          this.isVisible(series) &&
          this.source.columns.scaleIds[series] === scaleId &&
          (this.source.columns.flags[series] & CompactSeriesFlag.Stack) !== 0
        ) {
          this.seriesIndex = series;
          this.flags = this.source.columns.flags[series];
          this.source.scan(series, from, to, this.visitPoint);
        }
      }
      if (this.extentMin != null) {
        min = min == null ? this.extentMin : Math.min(min, this.extentMin);
        max = max == null ? this.extentMax : Math.max(max, this.extentMax!);
      }
    }

    this.operation = ScanOperation.None;
    return [min, max];
  }

  draw(plot: uPlot, from: number, to: number): void | Promise<boolean> {
    this.cancelProgressiveDraw();
    this.renderedPlot = plot;
    this.clearFocusOverlay();
    if (this.source.pointCount === 0 || from > to) {
      return;
    }
    this.plot = plot;
    this.context = plot.ctx;
    const scanFrom = Math.max(0, from - 1);
    const scanTo = Math.min(this.source.pointCount - 1, to + 1);
    this.focusScanFrom = scanFrom;
    this.focusScanTo = scanTo;
    this.focusVisibleFrom = from;
    this.focusVisibleTo = to;
    this.prepareStackScratch(scanFrom, scanTo);

    if (this.shouldDrawProgressively(scanFrom, scanTo)) {
      this.plot = null;
      this.context = null;
      return this.drawProgressively(plot, scanFrom, scanTo, from, to).then((completed) => {
        if (completed) {
          this.drawFocusOverlay();
        }
        return completed;
      });
    }

    this.drawSeriesRange(plot, 0, this.source.seriesCount, scanFrom, scanTo, from, to);
    this.drawFocusOverlay();
  }

  private drawSeriesRange(
    plot: uPlot,
    seriesFrom: number,
    seriesTo: number,
    scanFrom: number,
    scanTo: number,
    visibleFrom: number,
    visibleTo: number,
    context: CanvasRenderingContext2D = plot.ctx
  ): void {
    this.plot = plot;
    this.context = context;
    context.save();
    try {
      context.beginPath();
      context.rect(plot.bbox.left, plot.bbox.top, plot.bbox.width, plot.bbox.height);
      context.clip();

      for (let series = seriesFrom; series < seriesTo; series++) {
        if (!this.isVisible(series)) {
          continue;
        }
        this.drawSeries(series, scanFrom, scanTo, visibleFrom, visibleTo);
      }
    } finally {
      context.restore();
      this.gradientCache.length = 0;
      this.operation = ScanOperation.None;
      this.plot = null;
      this.context = null;
    }
  }

  private shouldDrawProgressively(from: number, to: number): boolean {
    if (this.source.stackGroupCount !== 0) {
      return false;
    }

    let visibleSeriesCount = 0;
    for (let series = 0; series < this.source.seriesCount; series++) {
      if (!this.isVisible(series)) {
        continue;
      }
      visibleSeriesCount++;
      const flags = this.source.columns.flags[series];
      const style = this.getStyle(series);
      if (
        (flags & CompactSeriesFlag.PathMask) !== CompactSeriesFlag.Linear ||
        (flags & CompactSeriesFlag.DrawLine) === 0 ||
        (flags & (CompactSeriesFlag.Points | CompactSeriesFlag.Stack)) !== 0 ||
        ((flags & CompactSeriesFlag.AutoPoints) !== 0 && this.shouldShowAutoPoints(style, from, to)) ||
        style.areaFill != null ||
        style.areaGradient != null ||
        (style.lineDash?.length ?? 0) !== 0 ||
        (style.alpha ?? 1) !== 1 ||
        style.showValues === true
      ) {
        return false;
      }
    }
    return visibleSeriesCount * (to - from + 1) >= PROGRESSIVE_SAMPLE_THRESHOLD;
  }

  private drawProgressively(
    plot: uPlot,
    scanFrom: number,
    scanTo: number,
    visibleFrom: number,
    visibleTo: number
  ): Promise<boolean> {
    const generation = ++this.progressiveGeneration;
    const seriesPerChunk = Math.max(1, Math.floor(PROGRESSIVE_POINT_BUDGET / (scanTo - scanFrom + 1)));
    let nextSeries = 0;

    return new Promise<boolean>((resolve) => {
      this.resolveProgressiveDraw = resolve;
      const drawChunk = () => {
        if (generation !== this.progressiveGeneration) {
          return;
        }
        const firstSeries = nextSeries;
        nextSeries = Math.min(this.source.seriesCount, firstSeries + seriesPerChunk);
        this.drawSeriesRange(plot, firstSeries, nextSeries, scanFrom, scanTo, visibleFrom, visibleTo);

        if (nextSeries >= this.source.seriesCount) {
          this.progressiveTimer = undefined;
          this.resolveProgressiveDraw = undefined;
          resolve(true);
          return;
        }
        this.progressiveTimer = window.setTimeout(drawChunk, 0);
      };
      drawChunk();
    });
  }

  private cancelProgressiveDraw(): void {
    this.progressiveGeneration++;
    if (this.progressiveTimer != null) {
      window.clearTimeout(this.progressiveTimer);
      this.progressiveTimer = undefined;
    }
    this.resolveProgressiveDraw?.(false);
    this.resolveProgressiveDraw = undefined;
  }

  setSeries(seriesIndex: number | null, options: { show?: boolean; focus?: boolean }): boolean {
    let redraw = false;
    if (options.show != null) {
      if (seriesIndex == null) {
        const visibility = options.show ? 1 : 0;
        for (let index = 0; index < this.source.seriesCount; index++) {
          if (this.source.columns.visibility[index] !== visibility) {
            this.source.columns.visibility[index] = visibility;
            redraw = true;
          }
        }
        this.visibleSeriesCount = visibility === 1 ? this.source.seriesCount : 0;
        this.source.visibilityState.globalVisibility = visibility;
        this.source.visibilityState.overrides.clear();
      } else {
        this.assertSeriesIndex(seriesIndex);
        const visibility = options.show ? 1 : 0;
        const previousVisibility = this.source.columns.visibility[seriesIndex];
        redraw = previousVisibility !== visibility;
        this.source.columns.visibility[seriesIndex] = visibility;
        if (redraw) {
          this.visibleSeriesCount += visibility === 1 ? 1 : -1;
        }
        this.updateVisibilityOverride(seriesIndex, visibility);
      }
      if (this.visibleSeriesCount < 2 || (this.focusedSeries >= 0 && !this.isVisible(this.focusedSeries))) {
        this.focusedSeries = -1;
        this.removeFocusOverlay();
      }
      if (
        this.visibleSeriesCount > 1 &&
        this.requestedFocusedSeries >= 0 &&
        this.isVisible(this.requestedFocusedSeries)
      ) {
        this.focusedSeries = this.requestedFocusedSeries;
        this.drawFocusOverlay();
      }
    }
    if (options.focus != null) {
      this.requestedFocusedSeries = options.focus && seriesIndex != null ? seriesIndex : -1;
      let nextFocus = -1;
      if (options.focus && seriesIndex != null && this.visibleSeriesCount > 1) {
        this.assertSeriesIndex(seriesIndex);
        if (this.isVisible(seriesIndex)) {
          nextFocus = seriesIndex;
        }
      }
      if (this.focusedSeries !== nextFocus) {
        this.focusedSeries = nextFocus;
        const redrawStartedAt = hoverStageProbe ? performance.now() : 0;
        this.drawFocusOverlay();
        hoverStageProbe?.record('focusRedraw', {
          durationMs: performance.now() - redrawStartedAt,
          focused: nextFocus >= 0,
        });
      }
    }
    if (redraw) {
      this.cancelProgressiveDraw();
    }
    return redraw;
  }

  setSeriesVisibility(seriesIndex: number | null, show: boolean): void {
    if (this.renderedPlot) {
      this.renderedPlot.setSeries(seriesIndex == null ? null : seriesIndex + 1, { show });
      return;
    }

    this.setSeries(seriesIndex, { show });
  }

  private updateVisibilityOverride(seriesIndex: number, visibility: number): void {
    if (!this.source.seriesIdentityAt || !this.source.seriesIdentityHashAt) {
      return;
    }
    const state = this.source.visibilityState;
    const hash = this.source.seriesIdentityHashAt(seriesIndex);
    const identity = this.source.seriesIdentityAt(seriesIndex);
    const overrides = state.overrides.get(hash) ?? [];
    const existing = overrides.findIndex((override) => override.identity === identity);
    if (state.globalVisibility === visibility) {
      if (existing >= 0) {
        overrides.splice(existing, 1);
      }
    } else if (existing >= 0) {
      overrides[existing].visibility = visibility;
    } else {
      overrides.push({ identity, visibility });
    }
    if (overrides.length === 0) {
      state.overrides.delete(hash);
    } else {
      state.overrides.set(hash, overrides);
    }
  }

  private applyVisibilityState(source: CompactRenderSource): void {
    const state = source.visibilityState;
    if (state.globalVisibility != null) {
      source.columns.visibility.fill(state.globalVisibility);
    }
    if (source.seriesIdentityAt && source.seriesIdentityHashAt && state.overrides.size > 0) {
      for (let seriesIndex = 0; seriesIndex < source.seriesCount; seriesIndex++) {
        const overrides = state.overrides.get(source.seriesIdentityHashAt(seriesIndex));
        if (!overrides) {
          continue;
        }
        const identity = source.seriesIdentityAt(seriesIndex);
        const override = overrides.find((candidate) => candidate.identity === identity);
        if (override) {
          source.columns.visibility[seriesIndex] = override.visibility;
        }
      }
    }
    let visibleSeriesCount = 0;
    for (let seriesIndex = 0; seriesIndex < source.seriesCount; seriesIndex++) {
      visibleSeriesCount += source.columns.visibility[seriesIndex] === 1 ? 1 : 0;
    }
    this.visibleSeriesCount = visibleSeriesCount;
  }

  updateCursor(
    plot: uPlot,
    index: number | null,
    mouseY: number,
    origin: uPlot.CompactCursorOrigin
  ): uPlot.CompactCursorState | null {
    const state = this.cursorState;
    state.hasPoint = false;
    state.seriesIndex = -1;
    state.dataIndex = -1;
    state.distance = Number.POSITIVE_INFINITY;
    state.left = -10;
    state.top = -10;
    state.size = 0;

    if (index == null || index < 0 || index >= this.source.pointCount) {
      return null;
    }

    const focusStartedAt = hoverStageProbe ? performance.now() : 0;
    if (this.source.stackGroupCount > 0) {
      this.cursorStackIndexes.fill(-1);
    }
    const needsSnapshot = origin !== 'native-sync' && this.source.cursorMode === 'multi';
    if (needsSnapshot) {
      this.ensureCursorSnapshotScratch();
      if (!this.isCursorSnapshotCurrent(index, plot)) {
        this.populateCursorSnapshot(index, plot, mouseY);
      } else {
        this.selectCursorPointFromSnapshot(plot, index, mouseY);
      }
    } else if (this.cursorSnapshotValues.length > 0 && this.isCursorSnapshotCurrent(index, plot)) {
      this.selectCursorPointFromSnapshot(plot, index, mouseY);
    } else {
      this.selectCursorPointFromSource(plot, index, mouseY);
    }
    hoverStageProbe?.record('focusSelection', {
      durationMs: performance.now() - focusStartedAt,
      seriesVisits: this.source.seriesCount,
      found: state.seriesIndex >= 0,
    });
    const focus = plot.focus;
    state.hasPoint = state.seriesIndex >= 0 && focus.prox >= 0 && state.distance <= focus.prox;
    return state;
  }

  private selectCursorPointFromSource(plot: uPlot, index: number, mouseY: number): void {
    for (let seriesIndex = 0; seriesIndex < this.source.seriesCount; seriesIndex++) {
      if (!this.isVisible(seriesIndex)) {
        continue;
      }
      let dataIndex = index;
      let value = this.source.yAt(seriesIndex, dataIndex);
      if (value == null) {
        const nearest = this.nearestPresentAtCursor(plot, seriesIndex, index);
        if (nearest == null) {
          continue;
        }
        dataIndex = nearest;
        value = this.source.yAt(seriesIndex, dataIndex);
      }
      this.considerCursorPoint(plot, seriesIndex, index, dataIndex, value, mouseY);
    }
  }

  private selectCursorPointFromSnapshot(plot: uPlot, index: number, mouseY: number): void {
    for (let seriesIndex = 0; seriesIndex < this.source.seriesCount; seriesIndex++) {
      if (!this.isVisible(seriesIndex)) {
        continue;
      }
      const dataIndex = this.readCursorSnapshotDataIndex(seriesIndex);
      const value =
        dataIndex === index ? this.readCursorSnapshotValue(seriesIndex) : this.source.yAt(seriesIndex, dataIndex);
      this.considerCursorPoint(plot, seriesIndex, index, dataIndex, value, mouseY);
    }
  }

  private considerCursorPoint(
    plot: uPlot,
    seriesIndex: number,
    cursorIndex: number,
    dataIndex: number,
    rawValue: CompactPlotValue,
    mouseY: number
  ): void {
    if (rawValue == null || !this.isWithinCursorProximity(plot, seriesIndex, cursorIndex, dataIndex)) {
      return;
    }

    const value = this.stackCursorValue(seriesIndex, dataIndex, rawValue);
    const scaleKey = this.getScaleKey(seriesIndex);
    const top = plot.valToPos(value, scaleKey);
    const focus = plot.focus;
    const distance = Math.abs(focus.dist?.(plot, seriesIndex + 1, dataIndex, top, mouseY) ?? top - mouseY);
    const bias = focus.bias ?? 0;
    if (bias !== 0) {
      const mouseValue = plot.posToVal(mouseY, scaleKey);
      const valueSign = value >= 0 ? 1 : -1;
      const mouseSign = mouseValue >= 0 ? 1 : -1;
      const matchesBias =
        valueSign === mouseSign &&
        (mouseSign === 1
          ? bias === 1
            ? value >= mouseValue
            : value <= mouseValue
          : bias === 1
            ? value <= mouseValue
            : value >= mouseValue);
      if (!matchesBias) {
        return;
      }
    }
    if (!(distance < this.cursorState.distance)) {
      return;
    }

    const style = this.getStyle(seriesIndex);
    this.cursorState.seriesIndex = seriesIndex;
    this.cursorState.dataIndex = dataIndex;
    this.cursorState.distance = distance;
    this.cursorState.left = plot.valToPos(this.source.xAt(dataIndex), 'x');
    this.cursorState.top = top;
    this.cursorState.size = style.pointSize ?? Math.max(5, (style.lineWidth ?? 1) * 3);
    this.cursorState.fill = style.fill ?? style.stroke;
    this.cursorState.stroke = style.stroke;
  }

  private isCursorSnapshotCurrent(index: number, plot?: uPlot): boolean {
    const mouseX = plot?.cursor.left;
    return this.cursorSnapshotIndex === index && (mouseX == null || mouseX === this.cursorSnapshotMouseX);
  }

  getCursorSnapshot(index: number, plot?: uPlot): CompactCursorSnapshot {
    if (!Number.isInteger(index) || index < 0 || index >= this.source.pointCount) {
      throw new Error(`Compact cursor index ${index} is outside the source`);
    }
    this.ensureCursorSnapshotScratch();
    if (!this.isCursorSnapshotCurrent(index, plot)) {
      this.populateCursorSnapshot(index, plot);
    }
    return this.cursorSnapshot;
  }

  private drawFocusOverlay(): void {
    const plot = this.renderedPlot;
    if (
      !plot ||
      this.focusedSeries < 0 ||
      this.visibleSeriesCount < 2 ||
      this.source.highlightSeriesOnHover !== true ||
      !this.isVisible(this.focusedSeries) ||
      this.source.pointCount === 0
    ) {
      this.removeFocusOverlay();
      return;
    }
    const context = this.ensureFocusOverlay(plot);
    if (!context) {
      return;
    }

    if ((this.source.columns.flags[this.focusedSeries] & CompactSeriesFlag.Stack) !== 0) {
      this.prepareStackScratch(this.focusScanFrom, this.focusScanTo);
      this.operation = ScanOperation.StackCommit;
      for (let series = 0; series < this.focusedSeries; series++) {
        if (!this.isVisible(series) || (this.source.columns.flags[series] & CompactSeriesFlag.Stack) === 0) {
          continue;
        }
        this.seriesIndex = series;
        this.flags = this.source.columns.flags[series];
        this.source.scan(series, this.focusScanFrom, this.focusScanTo, this.visitPoint);
      }
      this.operation = ScanOperation.None;
    }

    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    this.drawSeriesRange(
      plot,
      this.focusedSeries,
      this.focusedSeries + 1,
      this.focusScanFrom,
      this.focusScanTo,
      this.focusVisibleFrom,
      this.focusVisibleTo,
      context
    );
  }

  private clearFocusOverlay(): void {
    if (this.focusContext) {
      this.focusContext.clearRect(0, 0, this.focusContext.canvas.width, this.focusContext.canvas.height);
    }
  }

  private removeFocusOverlay(): void {
    this.focusCanvas?.remove();
    this.focusCanvas = null;
    this.focusContext = null;
  }

  private ensureFocusOverlay(plot: uPlot): CanvasRenderingContext2D | null {
    const mainCanvas = plot.ctx.canvas;
    if (!mainCanvas) {
      return null;
    }
    const parent = plot.over?.parentElement ?? mainCanvas.parentElement;
    if (!parent) {
      return null;
    }
    if (!this.focusCanvas) {
      const canvas = document.createElement('canvas');
      canvas.className = 'u-compact-focus-overlay';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      parent.insertBefore(canvas, plot.over ?? null);
      this.focusCanvas = canvas;
      this.focusContext = canvas.getContext('2d');
    }
    if (this.focusCanvas.width !== mainCanvas.width || this.focusCanvas.height !== mainCanvas.height) {
      this.focusCanvas.width = mainCanvas.width;
      this.focusCanvas.height = mainCanvas.height;
    }
    return this.focusContext;
  }

  private drawSeries(series: number, from: number, to: number, visibleFrom: number, visibleTo: number): void {
    const ctx = this.context!;
    const styleId = this.source.columns.styleIds[series];
    const style = this.source.styles[styleId];
    const flags = this.source.columns.flags[series];
    const hasLineGeometry = (flags & CompactSeriesFlag.DrawLine) !== 0;
    const hasFill = hasLineGeometry && (style.areaFill != null || style.areaGradient != null);
    const hasStroke = hasLineGeometry && (style.lineWidth ?? 1) > 0;
    const pathMode = flags & CompactSeriesFlag.PathMask;
    const hasSteppedPath = pathMode === CompactSeriesFlag.StepBefore || pathMode === CompactSeriesFlag.StepAfter;
    let lineFrom = from;
    let lineTo = to;
    if ((hasFill || hasStroke) && (flags & CompactSeriesFlag.Stack) === 0) {
      if (this.source.yAt(series, from) === undefined) {
        lineFrom = this.source.nearestPresent(series, from, -1) ?? from;
      }
      if (this.source.yAt(series, to) === undefined) {
        lineTo = this.source.nearestPresent(series, to, 1) ?? to;
      }
    }
    const hasPoints =
      (flags & CompactSeriesFlag.Points) !== 0 ||
      ((flags & CompactSeriesFlag.AutoPoints) !== 0 && this.shouldShowAutoPoints(style, visibleFrom, visibleTo));
    ctx.save();
    ctx.globalAlpha = style.alpha ?? 1;
    ctx.strokeStyle = style.stroke;
    ctx.fillStyle = style.fill ?? style.stroke;
    if ((style.lineWidth ?? 1) > 0) {
      ctx.lineWidth = (style.lineWidth ?? 1) * uPlot.pxRatio;
    }
    ctx.lineCap = style.lineCap ?? 'butt';
    ctx.setLineDash(style.lineDash ?? []);

    this.seriesIndex = series;
    this.flags = flags;
    this.scaleKey = this.getScaleKey(series);
    this.pathStarted = false;
    this.hasPath = false;
    this.hasPrevious = false;
    this.previousTimestamp = Number.NaN;

    const stacked = (flags & CompactSeriesFlag.Stack) !== 0;
    const needsGapClip =
      !stacked && ((hasFill && hasSteppedPath) || (hasStroke && (hasSteppedPath || style.lineDash?.length)));
    if (needsGapClip) {
      ctx.save();
      this.prepareGapClip(series, lineFrom, lineTo);
      this.clipAreaGaps = hasFill && hasSteppedPath;
      this.clipLineGaps = hasStroke && (hasSteppedPath || Boolean(style.lineDash?.length));
    }
    if (hasFill) {
      this.operation = ScanOperation.Area;
      this.pathStarted = false;
      this.hasPath = false;
      this.hasPrevious = false;
      this.stackAreaLength = 0;
      this.previousTimestamp = Number.NaN;
      this.fillBaselineY = this.getFillBaselineY();
      ctx.fillStyle = this.getAreaFill(style, styleId);
      ctx.beginPath();
      this.source.scan(series, lineFrom, lineTo, this.visitPoint);
      this.finishArea();
      if (this.hasPath) {
        ctx.fill();
      }
    }
    if (hasStroke) {
      this.pathStarted = false;
      this.hasPath = false;
      this.hasPrevious = false;
      this.previousTimestamp = Number.NaN;
      ctx.beginPath();
      if (this.shouldDecimateLine(style, flags, hasFill, lineFrom, lineTo)) {
        this.drawDecimatedLine(series, lineFrom, lineTo);
      } else if (this.drawDirectLinearLine(series, flags, style, lineFrom, lineTo)) {
        // The direct path has already appended the complete stroke geometry.
      } else {
        this.operation = ScanOperation.Line;
        this.source.scan(series, lineFrom, lineTo, this.visitPoint);
        this.finishLine();
      }
      if (this.hasPath) {
        ctx.stroke();
      }
    }
    if (needsGapClip) {
      ctx.restore();
      this.clipAreaGaps = false;
      this.clipLineGaps = false;
    }
    if (hasPoints) {
      this.operation = ScanOperation.Points;
      this.pathStarted = false;
      this.hasPath = false;
      ctx.fillStyle = style.fill ?? style.stroke;
      ctx.lineWidth = getPointStrokeWidth(style) * uPlot.pxRatio;
      ctx.lineCap = 'butt';
      ctx.setLineDash([]);
      ctx.beginPath();
      this.source.scan(series, from, to, this.visitPoint);
      if (this.hasPath) {
        if (style.fill != null) {
          ctx.fill();
        }
        ctx.stroke();
      }
    }
    if (style.showValues && hasPoints && this.source.formatValueAt) {
      this.drawValueLabels(series, from, to, style);
    }
    if ((flags & CompactSeriesFlag.Stack) !== 0) {
      this.operation = ScanOperation.StackCommit;
      this.source.scan(series, from, to, this.visitPoint);
    }
    ctx.restore();
  }

  private drawDirectLinearLine(
    series: number,
    flags: number,
    style: CompactStyleRecord,
    from: number,
    to: number
  ): boolean {
    if (
      (flags & CompactSeriesFlag.PathMask) !== CompactSeriesFlag.Linear ||
      (flags & CompactSeriesFlag.Stack) !== 0 ||
      style.disconnectThreshold != null ||
      !this.source.prepareBufferScan(series, from, this.bufferScan)
    ) {
      return false;
    }

    const xScale = this.plot!.scales.x;
    const yScale = this.plot!.scales[this.scaleKey];
    const scale = this.source.scales[this.source.columns.scaleIds[series]];
    if (
      xScale?.ori !== 0 ||
      xScale.distr !== 1 ||
      yScale?.ori !== 1 ||
      yScale?.distr !== 1 ||
      yScale?.min == null ||
      yScale.max == null ||
      yScale.min === yScale.max ||
      (scale.distribution != null && scale.distribution !== ScaleDistribution.Linear)
    ) {
      return false;
    }

    const firstTimestamp = this.bufferScan.axisStart + this.bufferScan.axisStep * from;
    const firstX = this.plot!.valToPos(firstTimestamp, 'x', true);
    const xStep = from === to ? 0 : this.plot!.valToPos(firstTimestamp + this.bufferScan.axisStep, 'x', true) - firstX;
    const minY = this.plot!.valToPos(yScale.min, this.scaleKey, true);
    const maxY = this.plot!.valToPos(yScale.max, this.scaleKey, true);
    const yMultiplier = (maxY - minY) / (yScale.max - yScale.min);
    const yOffset = minY - yScale.min * yMultiplier;
    let packedIndex = this.bufferScan.packedIndex;
    let pathStarted = false;

    for (let index = from; index <= to; index++) {
      let value = this.bufferScan.missingValue;
      const present =
        this.bufferScan.presenceByteLength === 0 ||
        (this.bufferBytes[this.bufferScan.presenceByteOffset + (index >> 3)] & (1 << (index & 7))) !== 0;
      if (present) {
        const sourceValue = this.bufferView.getFloat64(
          this.bufferScan.valuesByteOffset + packedIndex * Float64Array.BYTES_PER_ELEMENT,
          true
        );
        packedIndex++;
        value = Number.isFinite(sourceValue)
          ? sourceValue * this.bufferScan.valueMultiplier
          : this.bufferScan.missingValue;
      }

      if (value === undefined) {
        continue;
      }
      if (value === null) {
        pathStarted = false;
        continue;
      }

      const x = firstX + (index - from) * xStep;
      const y = yOffset + value * yMultiplier;
      if (pathStarted) {
        this.context!.lineTo(x, y);
      } else {
        this.context!.moveTo(x, y);
        pathStarted = true;
        this.hasPath = true;
      }
    }
    return true;
  }

  private visitArea(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    const value = this.resolveRenderValue(index, rawValue);
    if (value === null) {
      if (this.clipAreaGaps) {
        return;
      }
      this.finishArea();
      this.pathStarted = false;
      this.hasPrevious = false;
      this.previousTimestamp = Number.NaN;
      return;
    }
    if (value === undefined) {
      return;
    }
    const x = this.plot!.valToPos(timestamp, 'x', true);
    const y = this.plot!.valToPos(value, this.scaleKey, true);
    const pathMode = this.flags & CompactSeriesFlag.PathMask;

    if (this.shouldDisconnect(timestamp)) {
      this.finishArea();
      this.pathStarted = false;
      this.hasPrevious = false;
    }

    if (!this.pathStarted) {
      if ((this.flags & CompactSeriesFlag.Stack) !== 0) {
        this.context!.moveTo(x, y);
        this.recordStackAreaIndex(index);
      } else {
        this.context!.moveTo(x, this.fillBaselineY);
        this.context!.lineTo(x, y);
      }
      this.pathStarted = true;
      this.hasPath = true;
      this.previousX = x;
      this.previousY = y;
      this.previousTimestamp = timestamp;
      this.hasPrevious = true;
      return;
    }

    if (pathMode === CompactSeriesFlag.StepBefore) {
      this.context!.lineTo(this.previousX, y);
      this.context!.lineTo(x, y);
    } else if (pathMode === CompactSeriesFlag.StepAfter) {
      this.context!.lineTo(x, this.previousY);
      this.context!.lineTo(x, y);
    } else if (pathMode === CompactSeriesFlag.Spline) {
      const midX = (this.previousX + x) / 2;
      const midY = (this.previousY + y) / 2;
      this.context!.quadraticCurveTo(this.previousX, this.previousY, midX, midY);
    } else {
      this.context!.lineTo(x, y);
    }
    if ((this.flags & CompactSeriesFlag.Stack) !== 0) {
      this.recordStackAreaIndex(index);
    }

    this.previousX = x;
    this.previousY = y;
    this.previousTimestamp = timestamp;
    this.hasPrevious = true;
  }

  private prepareGapClip(series: number, from: number, to: number): void {
    const ctx = this.context!;
    this.operation = ScanOperation.GapClip;
    this.gapClipStartX = this.plot!.bbox.left;
    this.gapStartX = null;
    this.gapPreviousX = null;
    const pathMode = this.flags & CompactSeriesFlag.PathMask;
    const halfStroke = ((this.getStyle(series).lineWidth ?? 1) * uPlot.pxRatio) / 2;
    this.gapBoundaryOffset =
      pathMode === CompactSeriesFlag.StepBefore
        ? -halfStroke
        : pathMode === CompactSeriesFlag.StepAfter
          ? halfStroke
          : 0;
    this.hasGapClip = false;
    ctx.beginPath();
    this.source.scan(series, from, to, this.visitPoint);
    this.finishGapClip(this.plot!.bbox.left + this.plot!.bbox.width);
    if (this.hasGapClip) {
      ctx.clip();
    }
  }

  private visitGapClip(rawValue: CompactPlotValue, timestamp: number): void {
    const x = this.plot!.valToPos(timestamp, 'x', true);
    if (rawValue === null) {
      this.gapStartX ??= (this.gapPreviousX ?? x) + this.gapBoundaryOffset;
      return;
    }
    if (rawValue === undefined) {
      return;
    }
    if (this.gapStartX != null) {
      this.addGapClipRegion(this.gapClipStartX, this.gapStartX);
      this.gapClipStartX = x + this.gapBoundaryOffset;
      this.gapStartX = null;
      this.hasGapClip = true;
    }
    this.gapPreviousX = x;
  }

  private finishGapClip(rightEdge: number): void {
    if (this.gapStartX != null) {
      this.addGapClipRegion(this.gapClipStartX, this.gapStartX);
      this.hasGapClip = true;
    } else if (this.hasGapClip) {
      this.addGapClipRegion(this.gapClipStartX, rightEdge);
    }
  }

  private addGapClipRegion(fromX: number, toX: number): void {
    if (toX <= fromX) {
      return;
    }
    const bbox = this.plot!.bbox;
    this.context!.rect(fromX, bbox.top - 5, toX - fromX, bbox.height + 10);
  }

  private finishArea(): void {
    if (!this.pathStarted || !this.hasPrevious) {
      return;
    }
    if ((this.flags & CompactSeriesFlag.Stack) !== 0) {
      this.finishStackArea();
      return;
    }
    if ((this.flags & CompactSeriesFlag.PathMask) === CompactSeriesFlag.Spline) {
      this.context!.lineTo(this.previousX, this.previousY);
    }
    this.context!.lineTo(this.previousX, this.fillBaselineY);
    this.context!.closePath();
  }

  private finishStackArea(): void {
    if (this.stackAreaLength === 0) {
      return;
    }
    const pathMode = this.flags & CompactSeriesFlag.PathMask;
    const lastIndex = this.stackAreaIndexes[this.stackAreaLength - 1];
    let currentX = this.plot!.valToPos(this.source.xAt(lastIndex), 'x', true);
    let currentBaseY = this.plot!.valToPos(this.getStackBase(lastIndex), this.scaleKey, true);
    this.context!.lineTo(currentX, currentBaseY);

    for (let offset = this.stackAreaLength - 2; offset >= 0; offset--) {
      const previousIndex = this.stackAreaIndexes[offset];
      const previousX = this.plot!.valToPos(this.source.xAt(previousIndex), 'x', true);
      const previousBaseY = this.plot!.valToPos(this.getStackBase(previousIndex), this.scaleKey, true);
      if (pathMode === CompactSeriesFlag.StepBefore) {
        this.context!.lineTo(previousX, currentBaseY);
        this.context!.lineTo(previousX, previousBaseY);
      } else if (pathMode === CompactSeriesFlag.StepAfter) {
        this.context!.lineTo(currentX, previousBaseY);
        this.context!.lineTo(previousX, previousBaseY);
      } else {
        this.context!.lineTo(previousX, previousBaseY);
      }
      currentX = previousX;
      currentBaseY = previousBaseY;
    }
    this.context!.closePath();
    this.stackAreaLength = 0;
  }

  private recordStackAreaIndex(index: number): void {
    if (this.stackAreaIndexes.length <= this.stackAreaLength) {
      const next = new Int32Array(Math.max(16, this.stackAreaIndexes.length * 2));
      next.set(this.stackAreaIndexes);
      this.stackAreaIndexes = next;
    }
    this.stackAreaIndexes[this.stackAreaLength++] = index;
  }

  private visitLine(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    const value = this.resolveRenderValue(index, rawValue);
    if (value === null) {
      if (this.clipLineGaps) {
        return;
      }
      this.finishLine();
      this.pathStarted = false;
      this.hasPrevious = false;
      this.previousTimestamp = Number.NaN;
      return;
    }
    if (value === undefined) {
      return;
    }
    const x = this.plot!.valToPos(timestamp, 'x', true);
    const y = this.plot!.valToPos(value, this.scaleKey, true);
    const pathMode = this.flags & CompactSeriesFlag.PathMask;

    if (this.shouldDisconnect(timestamp)) {
      this.finishLine();
      this.pathStarted = false;
      this.hasPrevious = false;
    }

    if (!this.pathStarted) {
      this.context!.moveTo(x, y);
      this.pathStarted = true;
      this.hasPath = true;
      this.previousX = x;
      this.previousY = y;
      this.previousTimestamp = timestamp;
      this.hasPrevious = true;
      return;
    }

    if (pathMode === CompactSeriesFlag.StepBefore) {
      this.context!.lineTo(this.previousX, y);
      this.context!.lineTo(x, y);
    } else if (pathMode === CompactSeriesFlag.StepAfter) {
      this.context!.lineTo(x, this.previousY);
      this.context!.lineTo(x, y);
    } else if (pathMode === CompactSeriesFlag.Spline) {
      const midX = (this.previousX + x) / 2;
      const midY = (this.previousY + y) / 2;
      this.context!.quadraticCurveTo(this.previousX, this.previousY, midX, midY);
    } else {
      this.context!.lineTo(x, y);
    }

    this.previousX = x;
    this.previousY = y;
    this.previousTimestamp = timestamp;
    this.hasPrevious = true;
  }

  private shouldDecimateLine(
    style: CompactStyleRecord,
    flags: number,
    hasFill: boolean,
    from: number,
    to: number
  ): boolean {
    const xScale = this.plot!.scales.x;
    return (
      !hasFill &&
      (flags & CompactSeriesFlag.PathMask) === CompactSeriesFlag.Linear &&
      (flags & CompactSeriesFlag.Stack) === 0 &&
      (style.lineDash?.length ?? 0) === 0 &&
      style.disconnectThreshold == null &&
      xScale?.ori === 0 &&
      xScale.distr === 1 &&
      to - from >= this.plot!.bbox.width * 4
    );
  }

  private drawDecimatedLine(series: number, from: number, to: number): void {
    this.operation = ScanOperation.DecimatedLine;
    this.decimatedMin = null;
    this.decimatedMax = null;
    this.decimatedNextXValue = Number.NaN;
    this.decimatedPixelDirection = this.plot!.scales.x.dir === -1 ? -1 : 1;
    this.source.scan(series, from, to, this.visitPoint);
    this.flushDecimatedLine();
  }

  private visitDecimatedLine(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    if (rawValue === undefined) {
      return;
    }
    if (rawValue === null) {
      this.flushDecimatedLine();
      this.pathStarted = false;
      this.decimatedMin = null;
      this.decimatedMax = null;
      this.decimatedNextXValue = Number.NaN;
      return;
    }

    const value = this.renderValue(index, rawValue, true);
    if (this.decimatedMin == null || timestamp >= this.decimatedNextXValue) {
      this.flushDecimatedLine();
      this.decimatedX = Math.round(this.plot!.valToPos(timestamp, 'x', true));
      this.decimatedMin = value;
      this.decimatedMax = value;
      this.decimatedIn = value;
      this.decimatedOut = value;
      this.decimatedInIndex = index;
      this.decimatedOutIndex = index;
      this.decimatedMinIndex = index;
      this.decimatedMaxIndex = index;
      this.decimatedNextXValue = this.plot!.posToVal(this.decimatedX + this.decimatedPixelDirection, 'x', true);
      return;
    }

    this.decimatedOut = value;
    this.decimatedOutIndex = index;
    if (value < this.decimatedMin) {
      this.decimatedMin = value;
      this.decimatedMinIndex = index;
    }
    if (value > this.decimatedMax!) {
      this.decimatedMax = value;
      this.decimatedMaxIndex = index;
    }
  }

  private flushDecimatedLine(): void {
    if (this.decimatedMin == null) {
      return;
    }
    const x = this.decimatedX;
    const inY = this.plot!.valToPos(this.decimatedIn, this.scaleKey, true);
    const outY = this.plot!.valToPos(this.decimatedOut, this.scaleKey, true);
    if (!this.pathStarted) {
      this.context!.moveTo(x, inY);
      this.pathStarted = true;
      this.hasPath = true;
    } else {
      this.context!.lineTo(x, inY);
    }

    const hasInternalMin =
      this.decimatedMinIndex !== this.decimatedInIndex && this.decimatedMinIndex !== this.decimatedOutIndex;
    const hasInternalMax =
      this.decimatedMaxIndex !== this.decimatedInIndex && this.decimatedMaxIndex !== this.decimatedOutIndex;
    if (hasInternalMin && hasInternalMax) {
      if (this.decimatedMinIndex < this.decimatedMaxIndex) {
        this.context!.lineTo(x, this.plot!.valToPos(this.decimatedMin, this.scaleKey, true));
        this.context!.lineTo(x, this.plot!.valToPos(this.decimatedMax!, this.scaleKey, true));
      } else {
        this.context!.lineTo(x, this.plot!.valToPos(this.decimatedMax!, this.scaleKey, true));
        this.context!.lineTo(x, this.plot!.valToPos(this.decimatedMin, this.scaleKey, true));
      }
    } else if (hasInternalMin) {
      this.context!.lineTo(x, this.plot!.valToPos(this.decimatedMin, this.scaleKey, true));
    } else if (hasInternalMax) {
      this.context!.lineTo(x, this.plot!.valToPos(this.decimatedMax!, this.scaleKey, true));
    }
    if (this.decimatedOutIndex !== this.decimatedInIndex) {
      this.context!.lineTo(x, outY);
    }
    this.decimatedMin = null;
    this.decimatedMax = null;
  }

  private shouldDisconnect(timestamp: number): boolean {
    const style = this.getStyle(this.seriesIndex);
    const threshold = style.disconnectThreshold;
    if (threshold == null || !Number.isFinite(this.previousTimestamp)) {
      return false;
    }
    const delta = timestamp - this.previousTimestamp;
    if (delta <= threshold) {
      return false;
    }
    const spanThreshold = style.spanNullsThreshold;
    return spanThreshold == null || spanThreshold === -1 || delta >= spanThreshold;
  }

  private shouldShowAutoPoints(style: CompactStyleRecord, from: number, to: number): boolean {
    const x0 = this.plot!.valToPos(this.source.xAt(from), 'x', true);
    const x1 = this.plot!.valToPos(this.source.xAt(to), 'x', true);
    const pointSpace = style.pointSpace ?? (3 + Math.max(1, style.lineWidth ?? 1) * 2) * 2;
    return to - from <= Math.abs(x1 - x0) / (pointSpace * uPlot.pxRatio);
  }

  private getAreaFill(style: CompactStyleRecord, styleId: number): string | CanvasGradient {
    if (style.areaGradient == null) {
      return style.areaFill!;
    }
    const cached = this.gradientCache[styleId];
    if (cached) {
      return cached;
    }
    const bbox = this.plot!.bbox;
    const gradient = this.context!.createLinearGradient(0, bbox.top, 0, bbox.top + bbox.height);
    gradient.addColorStop(0, style.areaGradient[0]);
    gradient.addColorStop(1, style.areaGradient[1]);
    this.gradientCache[styleId] = gradient;
    return gradient;
  }

  private drawValueLabels(series: number, from: number, to: number, style: CompactStyleRecord): void {
    const ctx = this.context!;
    ctx.save();
    ctx.fillStyle = this.source.valueColor ?? style.stroke;
    ctx.font = `${12 * uPlot.pxRatio}px ${this.source.valueFontFamily ?? 'sans-serif'}`;
    ctx.textAlign = 'center';
    this.operation = ScanOperation.ValueLabel;
    this.seriesIndex = series;
    this.source.scan(series, from, to, this.visitPoint);
    ctx.restore();
  }

  private visitValueLabel(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    if (rawValue == null) {
      return;
    }
    const rendered = this.renderValue(index, rawValue, false);
    const x = this.plot!.valToPos(timestamp, 'x', true);
    const y = this.plot!.valToPos(rendered, this.scaleKey, true);
    this.context!.textBaseline = rendered < 0 ? 'top' : 'bottom';
    this.context!.fillText(
      this.source.formatValueAt!(this.seriesIndex, index, rendered),
      x,
      y + (rendered < 0 ? 15 : -5)
    );
  }

  private finishLine(): void {
    if ((this.flags & CompactSeriesFlag.PathMask) === CompactSeriesFlag.Spline && this.hasPrevious) {
      this.context!.lineTo(this.previousX, this.previousY);
    }
  }

  private getFillBaselineY(): number {
    const scale = this.plot!.scales[this.scaleKey];
    const baseline = scale?.distr === 3 ? (scale.dir === 1 ? scale.min : scale.max) : 0;
    return this.plot!.valToPos(baseline ?? 0, this.scaleKey, true);
  }

  private visitPointMarker(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    if (rawValue == null) {
      return;
    }
    const value = this.renderValue(index, rawValue, false);
    const x = this.plot!.valToPos(timestamp, 'x', true);
    const y = this.plot!.valToPos(value, this.scaleKey, true);
    const style = this.getStyle(this.seriesIndex);
    const pointWidth = getPointStrokeWidth(style);
    const pointSize = style.pointSize ?? 3 + Math.max(1, style.lineWidth ?? 1) * 2;
    const radius = (Math.max(0, pointSize - pointWidth) * uPlot.pxRatio) / 2;
    this.context!.moveTo(x + radius, y);
    this.context!.arc(x, y, radius, 0, Math.PI * 2);
    this.pathStarted = true;
    this.hasPath = true;
  }

  private visitStackExtent(index: number, rawValue: CompactPlotValue): void {
    const value = this.resolveRenderValue(index, rawValue);
    if (value == null) {
      return;
    }
    this.includeExtentValue(this.currentStackBase);
    this.includeExtentValue(value);
    if (rawValue != null) {
      this.commitStackValue(index, rawValue);
    }
  }

  private includeExtentValue(value: number): void {
    if (this.extentMode === 'positive' && value <= 0) {
      return;
    }
    this.extentMin = this.extentMin == null ? value : Math.min(this.extentMin, value);
    this.extentMax = this.extentMax == null ? value : Math.max(this.extentMax, value);
  }

  private visitStackPresence(index: number, rawValue: CompactPlotValue): void {
    if (rawValue == null) {
      return;
    }
    this.stackPresence[this.getStackScratchIndex(index)] = 1;
  }

  private visitStackCommit(index: number, rawValue: CompactPlotValue): void {
    if (rawValue != null) {
      this.commitStackValue(index, rawValue);
    }
  }

  private currentStackBase = 0;

  private resolveRenderValue(index: number, value: CompactPlotValue): CompactPlotValue {
    if (value != null) {
      return this.renderValue(index, value, false);
    }
    if ((this.flags & CompactSeriesFlag.Stack) === 0 || !this.hasStackValue(index)) {
      return value;
    }
    this.currentStackBase = this.getStackBase(index);
    return this.currentStackBase;
  }

  private renderValue(index: number, value: number, updateStack: boolean): number {
    this.currentStackBase = 0;
    if ((this.flags & CompactSeriesFlag.Stack) === 0) {
      return value;
    }
    const scratchIndex = this.getStackScratchIndex(index);
    const base = this.stackScratch[scratchIndex];
    this.currentStackBase = base;
    if (updateStack) {
      this.stackScratch[scratchIndex] = base + value;
    }
    return base + value;
  }

  private commitStackValue(index: number, value: number): void {
    this.renderValue(index, value, true);
  }

  private getStackBase(index: number): number {
    return this.stackScratch[this.getStackScratchIndex(index)];
  }

  private hasStackValue(index: number): boolean {
    return this.stackPresence[this.getStackScratchIndex(index)] !== 0;
  }

  private getStackScratchIndex(index: number): number {
    const group = this.getStackGroup(this.seriesIndex);
    if (group === 0) {
      throw new Error('Stacked compact series has no stack group');
    }
    return (group - 1) * this.stackPointCount + (index - this.stackFrom);
  }

  private stackCursorValue(series: number, dataIndex: number, value: number): number {
    if ((this.source.columns.flags[series] & CompactSeriesFlag.Stack) === 0) {
      return value;
    }
    const group = this.getStackGroup(series);
    const offset = group - 1;
    if (this.cursorStackIndexes[offset] === dataIndex) {
      this.cursorStacks[offset] += value;
      return this.cursorStacks[offset];
    }

    let stackedValue = value;
    for (let candidate = 0; candidate < series; candidate++) {
      if (
        !this.isVisible(candidate) ||
        (this.source.columns.flags[candidate] & CompactSeriesFlag.Stack) === 0 ||
        this.getStackGroup(candidate) !== group
      ) {
        continue;
      }
      const candidateValue = this.source.yAt(candidate, dataIndex);
      if (candidateValue != null) {
        stackedValue += candidateValue;
      }
    }
    this.cursorStackIndexes[offset] = dataIndex;
    this.cursorStacks[offset] = stackedValue;
    return stackedValue;
  }

  private prepareStackScratch(from: number, to: number): void {
    this.stackFrom = from;
    this.stackPointCount = to - from + 1;
    const required = this.stackPointCount * this.source.stackGroupCount;
    if (this.stackScratch.length < required) {
      this.stackScratch = new Float64Array(required);
    } else {
      this.stackScratch.fill(0, 0, required);
    }
    if (this.stackPresence.length < required) {
      this.stackPresence = new Uint8Array(required);
    } else {
      this.stackPresence.fill(0, 0, required);
    }
    this.operation = ScanOperation.StackPresence;
    for (let series = 0; series < this.source.seriesCount; series++) {
      if (this.isVisible(series) && (this.source.columns.flags[series] & CompactSeriesFlag.Stack) !== 0) {
        this.seriesIndex = series;
        this.flags = this.source.columns.flags[series];
        this.source.scan(series, from, to, this.visitPoint);
      }
    }
    this.operation = ScanOperation.None;
  }

  private ensureStackCursorScratch(): void {
    const required = this.source.stackGroupCount;
    if (this.cursorStacks.length !== required) {
      this.cursorStacks = new Float64Array(required);
      this.cursorStackIndexes = new Int32Array(required);
    }
  }

  private ensureCursorSnapshotScratch(): void {
    if (this.cursorSnapshotValues.length !== this.source.seriesCount) {
      this.cursorSnapshotValues = new Float64Array(this.source.seriesCount);
      this.cursorSnapshotStates = new Uint8Array(this.source.seriesCount);
      this.cursorSnapshotDataIndexes = null;
      this.invalidateCursorSnapshot();
    }
  }

  private populateCursorSnapshot(index: number, plot?: uPlot, mouseY?: number): void {
    const source = this.source;
    const startedAt = hoverStageProbe ? performance.now() : 0;
    let valueReads = 0;
    let nearestReads = 0;
    const previousIndex = this.cursorSnapshotIndex;
    const existingDataIndexes = this.cursorSnapshotDataIndexes;
    let changed = previousIndex !== index;

    for (let seriesIndex = 0; seriesIndex < source.seriesCount; seriesIndex++) {
      const previousState = this.cursorSnapshotStates[seriesIndex];
      const previousValue = this.cursorSnapshotValues[seriesIndex];
      const previousDataIndex = existingDataIndexes?.[seriesIndex] ?? previousIndex;
      let dataIndex = index;
      const value = source.cursorValueAt(seriesIndex, dataIndex);
      valueReads++;
      if (value == null) {
        const nearestIndex = plot
          ? this.nearestPresentAtCursor(plot, seriesIndex, index)
          : source.nearestPresent(seriesIndex, index, 0);
        nearestReads++;
        if (nearestIndex != null) {
          dataIndex = nearestIndex;
        }
      }

      if (dataIndex !== index) {
        if (!this.cursorSnapshotDataIndexes) {
          this.cursorSnapshotDataIndexes = new Int32Array(source.seriesCount);
          this.cursorSnapshotDataIndexes.fill(index);
        }
        this.cursorSnapshotDataIndexes[seriesIndex] = dataIndex;
      } else if (this.cursorSnapshotDataIndexes) {
        this.cursorSnapshotDataIndexes[seriesIndex] = index;
      }

      let state: CursorValueState;
      if (value === undefined) {
        state = CursorValueState.Undefined;
      } else if (value === null) {
        state = CursorValueState.Null;
      } else {
        state = CursorValueState.Number;
        this.cursorSnapshotValues[seriesIndex] = value;
      }
      this.cursorSnapshotStates[seriesIndex] = state;
      if (mouseY !== undefined && plot != null && this.isVisible(seriesIndex)) {
        const resolvedValue = dataIndex === index ? value : source.yAt(seriesIndex, dataIndex);
        this.considerCursorPoint(plot, seriesIndex, index, dataIndex, resolvedValue, mouseY);
      }
      if (
        !changed &&
        (state !== previousState ||
          dataIndex !== previousDataIndex ||
          (state === CursorValueState.Number && !Object.is(value, previousValue)))
      ) {
        changed = true;
      }
    }

    this.cursorSnapshotIndex = index;
    this.cursorSnapshotMouseX = plot?.cursor.left ?? Number.NaN;
    this.cursorSnapshot.cursorIndex = index;
    this.cursorSnapshot.timestamp = source.xAt(index);
    if (changed) {
      this.cursorSnapshot.revision++;
    }
    hoverStageProbe?.record('sampleResolution', {
      durationMs: performance.now() - startedAt,
      seriesVisits: source.seriesCount,
      valueReads,
      nearestReads,
    });
  }

  private readCursorSnapshotValue(seriesIndex: number): CompactPlotValue {
    this.assertSeriesIndex(seriesIndex);
    switch (this.cursorSnapshotStates[seriesIndex]) {
      case CursorValueState.Null:
        return null;
      case CursorValueState.Number:
        return this.cursorSnapshotValues[seriesIndex];
      default:
        return undefined;
    }
  }

  private readCursorSnapshotDataIndex(seriesIndex: number): number {
    this.assertSeriesIndex(seriesIndex);
    return this.cursorSnapshotDataIndexes?.[seriesIndex] ?? this.cursorSnapshotIndex;
  }

  private invalidateCursorSnapshot(): void {
    this.cursorSnapshotIndex = -1;
    this.cursorSnapshotMouseX = Number.NaN;
    this.cursorSnapshot.cursorIndex = -1;
    this.cursorSnapshot.timestamp = Number.NaN;
  }

  private nearestPresentAtCursor(plot: uPlot, seriesIndex: number, index: number): number | null {
    const source = this.source;
    const left = source.nearestPresent(seriesIndex, index, -1);
    const right = source.nearestPresent(seriesIndex, index, 1);
    if (left == null && right == null) {
      return null;
    }
    if (left == null) {
      return this.isWithinCursorProximity(plot, seriesIndex, index, right!) ? right : null;
    }
    if (right == null) {
      return this.isWithinCursorProximity(plot, seriesIndex, index, left) ? left : null;
    }
    if (this.getCursorProximity(plot, seriesIndex, index) == null) {
      return index - left <= right - index ? left : right;
    }
    const mouseX = this.requireCursorLeft(plot);
    const leftDistance = mouseX - plot.valToPos(source.xAt(left), 'x');
    const rightDistance = plot.valToPos(source.xAt(right), 'x') - mouseX;

    if (leftDistance <= rightDistance) {
      return this.isWithinCursorProximity(plot, seriesIndex, index, left) ? left : null;
    }
    return this.isWithinCursorProximity(plot, seriesIndex, index, right) ? right : null;
  }

  private isWithinCursorProximity(plot: uPlot, seriesIndex: number, hoveredIndex: number, dataIndex: number): boolean {
    const maxDistance = this.getCursorProximity(plot, seriesIndex, hoveredIndex);
    return (
      maxDistance == null ||
      Math.abs(this.requireCursorLeft(plot) - plot.valToPos(this.source.xAt(dataIndex), 'x')) <= maxDistance
    );
  }

  private getCursorProximity(plot: uPlot, seriesIndex: number, hoveredIndex: number): number | null {
    const proximity = plot.cursor.hover?.prox;
    const maxDistance =
      typeof proximity === 'function'
        ? proximity(plot, seriesIndex + 1, hoveredIndex, plot.posToVal(this.requireCursorLeft(plot), 'x'))
        : proximity;
    return maxDistance == null || maxDistance < 0 || !Number.isFinite(maxDistance) ? null : maxDistance;
  }

  private requireCursorLeft(plot: uPlot): number {
    const left = plot.cursor.left;
    if (left == null) {
      throw new Error('Compact cursor resolution requires a horizontal cursor position');
    }
    return left;
  }

  private isVisible(series: number): boolean {
    return this.source.columns.visibility[series] !== 0;
  }

  private getStyle(series: number): CompactStyleRecord {
    return this.source.styles[this.source.columns.styleIds[series]];
  }

  private getStackGroup(series: number): number {
    return this.source.columns.stackGroupIds?.[series] ?? 0;
  }

  private getScaleKey(series: number): string {
    return this.source.scales[this.source.columns.scaleIds[series]].key;
  }

  private findScaleId(scaleKey: string): number {
    for (let index = 0; index < this.source.scales.length; index++) {
      if (this.source.scales[index].key === scaleKey) {
        return index;
      }
    }
    return -1;
  }

  private assertSeriesIndex(seriesIndex: number): void {
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || seriesIndex >= this.source.seriesCount) {
      throw new RangeError(`Compact renderer series index ${seriesIndex} is out of range`);
    }
  }
}

function getPointStrokeWidth(style: CompactStyleRecord): number {
  if (style.pointLineWidth != null) {
    return style.pointLineWidth;
  }
  const seriesWidth = Math.max(1, style.lineWidth ?? 1);
  return Math.max(1, (3 + seriesWidth * 2) * 0.2);
}

function validateCompatibleSource(previous: CompactRenderSource, next: CompactRenderSource): void {
  validateSource(next);
  if (previous.stackGroupCount !== next.stackGroupCount) {
    throw new Error('Compact source replacement changed stack topology');
  }
  if (!columnsEqual(previous.columns.stackGroupIds, next.columns.stackGroupIds)) {
    throw new Error('Compact source replacement changed stack groups');
  }
  if (!stackFlagsEqual(previous.columns.flags, next.columns.flags)) {
    throw new Error('Compact source replacement changed stack participation');
  }
  if (previous.scales.length !== next.scales.length) {
    throw new Error('Compact source replacement changed scale topology');
  }
  for (let index = 0; index < previous.scales.length; index++) {
    if (JSON.stringify(previous.scales[index]) !== JSON.stringify(next.scales[index])) {
      throw new Error('Compact source replacement changed scale identity');
    }
  }
}

function copyVisibilityState(previous: CompactVisibilityState, next: CompactVisibilityState): void {
  if (previous === next) {
    return;
  }
  next.globalVisibility = previous.globalVisibility;
  next.overrides.clear();
  for (const [hash, overrides] of previous.overrides) {
    next.overrides.set(
      hash,
      overrides.map((override) => ({ ...override }))
    );
  }
}

function validateSource(source: CompactRenderSource): void {
  const { columns, seriesCount } = source;
  if (!(source.visibilityState?.overrides instanceof Map)) {
    throw new Error('Compact renderer requires visibility state');
  }
  if (Boolean(source.seriesIdentityAt) !== Boolean(source.seriesIdentityHashAt)) {
    throw new Error('Compact renderer identity accessors must be provided together');
  }
  if (typeof source.prepareBufferScan !== 'function') {
    throw new Error('Compact renderer requires direct buffer scan preparation');
  }
  const columnEntries: Array<[string, CompactIndexColumn]> = [
    ['styleIds', columns.styleIds],
    ['scaleIds', columns.scaleIds],
    ['flags', columns.flags],
    ['visibility', columns.visibility],
  ];
  if (columns.stackGroupIds) {
    columnEntries.push(['stackGroupIds', columns.stackGroupIds]);
  } else if (source.stackGroupCount !== 0) {
    throw new Error('Compact renderer cannot declare stack groups without stack metadata');
  }
  for (const [name, column] of columnEntries) {
    if (column.length !== seriesCount) {
      throw new Error(`Compact renderer ${name} column must contain exactly ${seriesCount} entries`);
    }
  }
  if (!Number.isInteger(source.stackGroupCount) || source.stackGroupCount < 0) {
    throw new Error('Compact renderer stackGroupCount must be a non-negative integer');
  }
  for (let series = 0; series < seriesCount; series++) {
    if (columns.styleIds[series] >= source.styles.length) {
      throw new Error(`Compact renderer series ${series} references a missing style`);
    }
    if (columns.scaleIds[series] >= source.scales.length) {
      throw new Error(`Compact renderer series ${series} references a missing scale`);
    }
    if (columns.visibility[series] > 1) {
      throw new Error(`Compact renderer visibility must be zero or one`);
    }
    const stackGroup = columns.stackGroupIds?.[series] ?? 0;
    const stacked = (columns.flags[series] & CompactSeriesFlag.Stack) !== 0;
    if ((columns.flags[series] & CompactSeriesFlag.PercentStack) !== 0) {
      throw new Error('Compact renderer does not support percent stacking');
    }
    if ((stacked && (stackGroup === 0 || stackGroup > source.stackGroupCount)) || (!stacked && stackGroup !== 0)) {
      throw new Error(`Compact renderer series ${series} has invalid stack metadata`);
    }
  }
}

function columnsEqual(left: CompactIndexColumn | undefined, right: CompactIndexColumn | undefined): boolean {
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

function stackFlagsEqual(left: CompactIndexColumn, right: CompactIndexColumn): boolean {
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
