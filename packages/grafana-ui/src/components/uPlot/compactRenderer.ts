import uPlot from 'uplot';

import { ScaleDirection, ScaleDistribution, ScaleOrientation, StackingMode } from '@grafana/schema';

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
  Bars = 1 << 8,
  Constant = 1 << 9,
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
  /** Series color at legacy cursor-border opacity. */
  readonly cursorStroke: string;
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
  readonly barAlignment?: -1 | 0 | 1;
  readonly barWidthFactor?: number;
  readonly barMaxWidth?: number;
}

export interface CompactBarRenderOptions {
  readonly mode: 'timeseries' | 'grouped';
  readonly groupWidth?: number;
  readonly barWidth?: number;
  readonly barRadius?: number;
  readonly showValue?: 'auto' | 'always' | 'never';
  readonly valueSize?: number;
  readonly fullHighlight?: boolean;
}

interface CompactRect {
  left: number;
  top: number;
  width: number;
  height: number;
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
  readonly focusOverlayColor?: string;
  seriesIdentityAt?(seriesIndex: number): string;
  seriesIdentityHashAt?(seriesIndex: number): number;
  formatValueAt?(seriesIndex: number, index: number, value: number): string;
  readonly valueColor?: string;
  readonly valueFontFamily?: string;
  readonly barOptions?: CompactBarRenderOptions;
  readonly barLayoutVisibility?: Uint8Array;
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

const enum CursorTargetPriority {
  NearbyGeometry,
  AreaFill,
  DistantGeometry,
}

const enum ScanOperation {
  None,
  Area,
  Bars,
  BarValueSize,
  GapClip,
  Line,
  Points,
  StackExtent,
  StackPresence,
  StackTotal,
  StackCommit,
  ValueLabel,
  DecimatedLine,
}

const controllers = new WeakMap<CompactRenderSource, CompactRenderController>();
const PROGRESSIVE_SAMPLE_THRESHOLD = 1_000_000;
const PROGRESSIVE_POINT_BUDGET = 32_000;
const CURSOR_STACK_CACHE_SIZE = 4;
const BAR_VALUE_MIN_FONT_SIZE = 8;
const BAR_VALUE_MAX_FONT_SIZE = 30;
const BAR_VALUE_FIT_RATIO = 0.65;
const retainPixel = (value: number) => value;
const hoverStageProbe = getCompactHoverStageProbe();

function normalizeBarCadence(value: number): number {
  const cadence = Math.abs(value);
  return Number.isInteger(cadence) ? cadence : Number(cadence.toFixed(6));
}

interface CompactBarWidthSample {
  readonly previousTimestamp: number;
  readonly timestamp: number;
}

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
  source: CompactRenderSource,
  valueScaleOrientation: ScaleOrientation = ScaleOrientation.Vertical
): CompactRenderController {
  const controller = new CompactRenderController(source);
  const percentScaleIds = new Uint8Array(source.scales.length);
  for (let series = 0; series < source.seriesCount; series++) {
    if ((source.columns.flags[series] & CompactSeriesFlag.PercentStack) !== 0) {
      percentScaleIds[source.columns.scaleIds[series]] = 1;
    }
  }
  for (let scaleId = 0; scaleId < source.scales.length; scaleId++) {
    const scale = source.scales[scaleId];
    builder.addScale({
      scaleKey: scale.key,
      isTime: false,
      orientation: valueScaleOrientation,
      direction: valueScaleOrientation === ScaleOrientation.Vertical ? ScaleDirection.Up : ScaleDirection.Right,
      min: scale.min,
      max: scale.max,
      softMin: scale.softMin,
      softMax: scale.softMax,
      distribution: scale.distribution,
      log: scale.log,
      linearThreshold: scale.linearThreshold,
      centeredZero: scale.centeredZero,
      decimals: scale.decimals,
      stackingMode: percentScaleIds[scaleId] === 1 ? StackingMode.Percent : undefined,
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

/** Returns true when a source can use the renderer's asynchronous chunked draw path. */
export function mayDrawCompactSourceProgressively(source: CompactRenderSource): boolean {
  if (source.stackGroupCount !== 0) {
    return false;
  }

  let visibleSeriesCount = 0;
  for (let series = 0; series < source.seriesCount; series++) {
    if (source.columns.visibility[series] !== 1) {
      continue;
    }
    visibleSeriesCount++;
    const flags = source.columns.flags[series];
    const style = source.styles[source.columns.styleIds[series]];
    if (
      (flags & CompactSeriesFlag.PathMask) !== CompactSeriesFlag.Linear ||
      (flags & CompactSeriesFlag.DrawLine) === 0 ||
      (flags & (CompactSeriesFlag.Points | CompactSeriesFlag.Stack | CompactSeriesFlag.Bars)) !== 0 ||
      style.areaFill != null ||
      style.areaGradient != null ||
      (style.lineDash?.length ?? 0) !== 0 ||
      (style.alpha ?? 1) !== 1 ||
      style.showValues === true
    ) {
      return false;
    }
  }
  return visibleSeriesCount * source.pointCount >= PROGRESSIVE_SAMPLE_THRESHOLD;
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
  private stackTotals = new Float64Array(0);
  private stackAreaIndexes = new Int32Array(0);
  private stackAreaLength = 0;
  private barSlots = new Int32Array(0);
  private visibleBarSlotCount = 0;
  private groupedBarGroupWidth = 0.7;
  private groupedBarWidth = 0.97;
  private readonly barLabelBounds = new Map<number, CompactRect[]>();
  private cursorStacks = new Float64Array(0);
  private cursorStackTotals = new Float64Array(0);
  private cursorStackIndexes = new Int32Array(0);
  private cursorStackNextSeries = new Int32Array(0);
  private cursorSnapshotValues = new Float64Array(0);
  private cursorSnapshotStates = new Uint8Array(0);
  private cursorSnapshotDataIndexes: Int32Array | null = null;
  private cursorSnapshotIndex = -1;
  private cursorSnapshotMouseX = Number.NaN;
  private cursorTargetPriority = CursorTargetPriority.DistantGeometry;
  private cursorTargetLineDistance = Number.POSITIVE_INFINITY;
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
  private barSlot = 0;
  private barSlotCount = 1;
  private barRoundOuterEdge = true;
  private barColumnWidth = 0;
  private barWidth = 0;
  private barShift = 0;
  private barStrokeWidth = 0;
  private barPixelRound = retainPixel;
  private barBaselineRound = retainPixel;
  private groupedBarConfiguredStrokeWidth = 0;
  private groupedBarStrokeSuppressed = false;
  private groupedBarAutoValueFontSize: number | null = null;
  private barWidthSamples: Array<CompactBarWidthSample | null> = [];
  private barWidthSamplesPrepared = false;
  private firstVisibleStackSeries = new Int32Array(0);
  private lastVisibleStackSeries = new Int32Array(0);
  private groupedBarLookupIndex = 0;
  private batchBarPath = false;
  private currentCursorStackBase = 0;
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
    width: 0,
    height: 0,
    centered: true,
    fill: 'transparent',
    stroke: 'transparent',
  };

  private readonly visitPoint = (index: number, value: CompactPlotValue, timestamp?: number): void => {
    const groupedBarScan =
      (this.operation === ScanOperation.Bars || this.operation === ScanOperation.BarValueSize) &&
      this.source.barOptions?.mode === 'grouped';
    const xValue = timestamp ?? (groupedBarScan ? index : this.source.xAt(index));
    switch (this.operation) {
      case ScanOperation.Area:
        this.visitArea(index, value, xValue);
        break;
      case ScanOperation.Bars:
        this.visitBar(index, value, xValue);
        break;
      case ScanOperation.BarValueSize:
        this.visitBarValueSize(index, value, xValue);
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
      case ScanOperation.StackTotal:
        this.visitStackTotal(index, value);
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
    this.visibleSeriesCount = applyCompactVisibilityState(source);
    this.initializeBarSlots();
    this.ensureStackCursorScratch();
  }

  groupedBarIndexAt(value: number): number {
    const pointCount = this.source.pointCount;
    if (pointCount === 0) {
      return value;
    }
    const first = this.source.xAt(0);
    if (pointCount === 1) {
      return value - first;
    }

    const lastIndex = pointCount - 1;
    const lookupIndex = Math.min(lastIndex, this.groupedBarLookupIndex);
    if (this.source.xAt(lookupIndex) === value) {
      return lookupIndex;
    }
    if (lookupIndex < lastIndex && this.source.xAt(lookupIndex + 1) === value) {
      return ++this.groupedBarLookupIndex;
    }
    if (lookupIndex > 0 && this.source.xAt(lookupIndex - 1) === value) {
      return --this.groupedBarLookupIndex;
    }

    let lowerIndex: number;
    if (value <= first) {
      lowerIndex = 0;
    } else if (value >= this.source.xAt(lastIndex)) {
      lowerIndex = lastIndex - 1;
    } else {
      const nearestIndex = this.source.closestXIndex(value, 0, lastIndex);
      if (this.source.xAt(nearestIndex) === value) {
        this.groupedBarLookupIndex = nearestIndex;
        return nearestIndex;
      }
      lowerIndex = this.source.xAt(nearestIndex) <= value ? nearestIndex : nearestIndex - 1;
      lowerIndex = Math.max(0, Math.min(lastIndex - 1, lowerIndex));
    }

    this.groupedBarLookupIndex = lowerIndex;
    const lower = this.source.xAt(lowerIndex);
    const upper = this.source.xAt(lowerIndex + 1);
    return upper === lower ? lowerIndex : lowerIndex + (value - lower) / (upper - lower);
  }

  groupedBarValueAt(index: number): number {
    const pointCount = this.source.pointCount;
    if (pointCount === 0) {
      return index;
    }
    const first = this.source.xAt(0);
    if (pointCount === 1) {
      return first + index;
    }

    const lowerIndex = Math.max(0, Math.min(pointCount - 2, Math.floor(index)));
    const lower = this.source.xAt(lowerIndex);
    const upper = this.source.xAt(lowerIndex + 1);
    return lower + (upper - lower) * (index - lowerIndex);
  }

  groupedBarIncrement(): number {
    const intervalCount = this.source.pointCount - 1;
    if (intervalCount <= 0) {
      return 1000;
    }
    const sampleCount = Math.min(intervalCount, 64);
    let minimum = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < sampleCount; sample++) {
      const index = sampleCount === 1 ? 0 : Math.floor((sample * (intervalCount - 1)) / (sampleCount - 1));
      const increment = Math.abs(this.source.xAt(index + 1) - this.source.xAt(index));
      if (increment > 0) {
        minimum = Math.min(minimum, increment);
      }
    }
    return Number.isFinite(minimum) ? minimum : 1000;
  }

  groupedBarRange(): [number, number] {
    const pointCount = this.source.pointCount;
    if (pointCount === 0) {
      return [0, 1];
    }
    const groupWidth = this.groupedBarGroupWidth;
    const rangeWidth = Math.max(1, pointCount - 1);
    const edgePosition = groupWidth / (2 * pointCount);
    let minimumIndex = 0;
    let maximumIndex = rangeWidth;
    if (edgePosition === 0.5) {
      minimumIndex -= rangeWidth;
    } else {
      const expandedWidth = rangeWidth / (1 - edgePosition * 2);
      const offset = (expandedWidth - rangeWidth) / 2;
      minimumIndex -= offset;
      maximumIndex += offset;
    }
    return [this.groupedBarValueAt(minimumIndex), this.groupedBarValueAt(maximumIndex)];
  }

  groupedBarSplits(minimum: number, maximum: number, maximumCount: number): number[] {
    const pointCount = this.source.pointCount;
    if (pointCount === 0) {
      return [];
    }
    const from = Math.max(0, Math.ceil(this.groupedBarIndexAt(minimum)));
    const to = Math.min(pointCount - 1, Math.floor(this.groupedBarIndexAt(maximum)));
    if (from > to) {
      return [];
    }
    const count = to - from + 1;
    const limit = Number.isFinite(maximumCount) ? Math.max(1, Math.floor(maximumCount)) : count;
    const splitCount = Math.min(count, limit);
    if (splitCount === 1) {
      return [this.source.xAt(from)];
    }

    const splits = new Array<number>(splitCount);
    for (let split = 0; split < splitCount; split++) {
      const index = from + Math.round((split * (count - 1)) / (splitCount - 1));
      splits[split] = this.source.xAt(index);
    }
    return splits;
  }

  replaceSource(oldSource: uPlot.CompactPlotSource, nextSource: uPlot.CompactPlotSource): void {
    if (oldSource !== this.source) {
      throw new Error('Compact renderer source ownership mismatch');
    }
    if (!isCompactRenderSource(nextSource)) {
      throw new Error('Compact renderer requires typed render columns');
    }
    const visibleSeriesCount = transferCompactVisibilityState(this.source, nextSource);
    this.cancelProgressiveDraw();
    const previousSource = this.source;
    controllers.delete(previousSource);
    this.source = nextSource;
    this.groupedBarLookupIndex = 0;
    this.bufferView = new DataView(nextSource.buffer);
    this.bufferBytes = new Uint8Array(nextSource.buffer);
    this.cursorSnapshot.source = nextSource;
    this.cursorSnapshot.seriesCount = nextSource.seriesCount;
    this.invalidateCursorSnapshot();
    this.visibleSeriesCount = visibleSeriesCount;
    this.initializeBarSlots();
    this.focusedSeries = -1;
    this.requestedFocusedSeries = -1;
    this.removeFocusOverlay();
    this.stackScratch = new Float64Array(0);
    this.stackPresence = new Uint8Array(0);
    this.stackTotals = new Float64Array(0);
    this.stackAreaIndexes = new Int32Array(0);
    this.stackAreaLength = 0;
    this.invalidateBarWidthSamples();
    this.barLabelBounds.clear();
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
    this.invalidateBarWidthSamples();
    this.barSlots = new Int32Array(0);
    this.visibleBarSlotCount = 0;
    this.barLabelBounds.clear();
    this.cursorStacks = new Float64Array(0);
    this.cursorStackTotals = new Float64Array(0);
    this.cursorStackIndexes = new Int32Array(0);
    this.cursorStackNextSeries = new Int32Array(0);
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
    this.barLabelBounds.clear();
    this.prepareStackScratch(scanFrom, scanTo);
    this.prepareGroupedBarAutoValueFontSize(scanFrom, scanTo);

    if (this.shouldDrawProgressively(scanFrom, scanTo)) {
      this.plot = null;
      this.context = null;
      return this.drawProgressively(plot, scanFrom, scanTo, from, to).then((completed) => {
        if (completed) {
          this.drawFocusOverlay();
        }
        this.barLabelBounds.clear();
        return completed;
      });
    }

    this.drawSeriesRange(plot, 0, this.source.seriesCount, scanFrom, scanTo, from, to);
    this.barLabelBounds.clear();
    this.drawFocusOverlay();
    this.barLabelBounds.clear();
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
        (flags & (CompactSeriesFlag.Points | CompactSeriesFlag.Stack | CompactSeriesFlag.Bars)) !== 0 ||
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
        const globalVisibility = options.show ? 1 : 0;
        let visibleSeriesCount = 0;
        for (let index = 0; index < this.source.seriesCount; index++) {
          const visibility = globalVisibility === 1 ? (this.source.barLayoutVisibility?.[index] ?? 1) : 0;
          if (this.source.columns.visibility[index] !== visibility) {
            this.source.columns.visibility[index] = visibility;
            redraw = true;
          }
          visibleSeriesCount += visibility;
        }
        this.visibleSeriesCount = visibleSeriesCount;
        this.source.visibilityState.globalVisibility = globalVisibility;
        this.source.visibilityState.overrides.clear();
      } else {
        this.assertSeriesIndex(seriesIndex);
        const visibility = options.show ? (this.source.barLayoutVisibility?.[seriesIndex] ?? 1) : 0;
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
      if (redraw) {
        if (this.source.barOptions?.mode === 'grouped') {
          this.initializeBarSlots();
        }
        this.invalidateBarWidthSamples();
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

  private initializeBarSlots(): void {
    if (this.barSlots.length !== this.source.seriesCount) {
      this.barSlots = new Int32Array(this.source.seriesCount);
    }
    this.barSlots.fill(-1);
    let configuredBarCount = 0;
    let slot = 0;
    let stacked = false;
    for (let series = 0; series < this.source.seriesCount; series++) {
      const flags = this.source.columns.flags[series];
      if ((this.source.barLayoutVisibility?.[series] ?? 1) !== 0 && (flags & CompactSeriesFlag.Bars) !== 0) {
        configuredBarCount++;
        stacked ||= (flags & CompactSeriesFlag.Stack) !== 0;
      }
      if (this.source.columns.visibility[series] !== 0 && (flags & CompactSeriesFlag.Bars) !== 0) {
        this.barSlots[series] = slot++;
      }
    }
    this.visibleBarSlotCount = slot;

    let groupWidth = Math.max(0, Math.min(1, this.source.barOptions?.groupWidth ?? 0.7));
    let barWidth = Math.max(0, Math.min(1, this.source.barOptions?.barWidth ?? 0.97));
    if (stacked) {
      [groupWidth, barWidth] = [barWidth, groupWidth];
    } else {
      if (configuredBarCount === 1) {
        groupWidth = barWidth;
      }
      if (slot === 1) {
        barWidth = 1;
      }
    }
    this.groupedBarGroupWidth = groupWidth;
    this.groupedBarWidth = barWidth;
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
    state.width = 0;
    state.height = 0;
    state.centered = true;
    state.fill = '';
    state.stroke = '';
    this.cursorTargetPriority = CursorTargetPriority.DistantGeometry;
    this.cursorTargetLineDistance = Number.POSITIVE_INFINITY;

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
    state.hasPoint =
      state.seriesIndex >= 0 && focus.prox >= 0 && (origin === 'native-sync' || state.distance <= focus.prox);
    if (!state.hasPoint) {
      state.seriesIndex = -1;
      state.dataIndex = -1;
      state.left = -10;
      state.top = -10;
      state.size = 0;
      state.width = 0;
      state.height = 0;
      state.centered = true;
      state.fill = '';
      state.stroke = '';
    }
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
    if (rawValue == null) {
      return;
    }

    const flags = this.source.columns.flags[seriesIndex];
    const groupedBar = this.source.barOptions?.mode === 'grouped' && (flags & CompactSeriesFlag.Bars) !== 0;
    if (!groupedBar && !this.isWithinCursorProximity(plot, seriesIndex, cursorIndex, dataIndex)) {
      return;
    }
    this.currentCursorStackBase = 0;
    const value = this.stackCursorValue(seriesIndex, dataIndex, rawValue);
    const scaleKey = this.getScaleKey(seriesIndex);
    const top = plot.valToPos(value, scaleKey);
    const style = this.getStyle(seriesIndex);
    const barRect = groupedBar ? this.getCursorBarRect(plot, seriesIndex, dataIndex, value, scaleKey) : null;
    if (
      groupedBar &&
      (!barRect || !rectContains(barRect, this.requireCursorGroupPosition(plot), mouseY, plot.scales.x.ori === 1))
    ) {
      return;
    }
    const focus = plot.focus;
    const lineDistance = barRect
      ? 0
      : Math.abs(focus.dist?.(plot, seriesIndex + 1, dataIndex, top, mouseY) ?? top - mouseY);
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
    const areaFillTarget =
      barRect == null && dataIndex === cursorIndex && this.isAreaFillTarget(plot, flags, style, scaleKey, top, mouseY);
    const targetPriority =
      lineDistance <= focus.prox
        ? CursorTargetPriority.NearbyGeometry
        : areaFillTarget
          ? CursorTargetPriority.AreaFill
          : CursorTargetPriority.DistantGeometry;
    const betterTarget =
      targetPriority < this.cursorTargetPriority ||
      (targetPriority === this.cursorTargetPriority && lineDistance < this.cursorTargetLineDistance);
    if (!betterTarget) {
      return;
    }

    this.cursorTargetPriority = targetPriority;
    this.cursorTargetLineDistance = lineDistance;
    this.cursorState.seriesIndex = seriesIndex;
    this.cursorState.dataIndex = dataIndex;
    this.cursorState.distance = targetPriority === CursorTargetPriority.AreaFill ? 0 : lineDistance;
    const groupPosition = plot.valToPos(this.source.xAt(dataIndex), 'x');
    if (plot.scales.x.ori === 1) {
      this.cursorState.left = top;
      this.cursorState.top = groupPosition;
    } else {
      this.cursorState.left = groupPosition;
      this.cursorState.top = top;
    }
    this.cursorState.size = (style.pointSize ?? Math.max(5, (style.lineWidth ?? 1) * 3)) * 2;
    this.cursorState.width = this.cursorState.size;
    this.cursorState.height = this.cursorState.size;
    this.cursorState.centered = true;
    this.cursorState.fill = style.stroke;
    this.cursorState.stroke = style.cursorStroke;

    if (barRect) {
      this.cursorState.left = barRect.left;
      this.cursorState.top = barRect.top;
      this.cursorState.width = barRect.width;
      this.cursorState.height = barRect.height;
      this.cursorState.centered = false;
      this.cursorState.fill = 'rgba(255, 255, 255, 0.4)';
      this.cursorState.stroke = 'transparent';
    }
  }

  private isAreaFillTarget(
    plot: uPlot,
    flags: number,
    style: CompactStyleRecord,
    scaleKey: string,
    valuePosition: number,
    cursorPosition: number
  ): boolean {
    if (
      (flags & CompactSeriesFlag.DrawLine) === 0 ||
      (style.areaFill == null && style.areaGradient == null) ||
      (style.alpha ?? 1) <= 0
    ) {
      return false;
    }
    const baseline =
      (flags & CompactSeriesFlag.Stack) !== 0 ? this.currentCursorStackBase : this.getFillBaselineValue(plot, scaleKey);
    const baselinePosition = plot.valToPos(baseline, scaleKey);
    return (
      cursorPosition >= Math.min(valuePosition, baselinePosition) &&
      cursorPosition <= Math.max(valuePosition, baselinePosition)
    );
  }

  private getCursorBarRect(
    plot: uPlot,
    seriesIndex: number,
    dataIndex: number,
    value: number,
    scaleKey: string
  ): CompactRect | null {
    const previousFlags = this.flags;
    const previousSlot = this.barSlot;
    const previousSlotCount = this.barSlotCount;
    const flags = this.source.columns.flags[seriesIndex];
    const slot = this.getConfiguredBarSlot(seriesIndex);
    this.flags = flags;
    this.barSlot = slot.index;
    this.barSlotCount = slot.count;
    const band = this.getBarBandForPlot(plot, dataIndex, this.source.xAt(dataIndex), false);
    const placement = this.getGroupedBarPlacement(band.center, band.size, 1);
    this.flags = previousFlags;
    this.barSlot = previousSlot;
    this.barSlotCount = previousSlotCount;

    const valuePosition = plot.valToPos(value, scaleKey);
    const basePosition = plot.valToPos(this.currentCursorStackBase, scaleKey);
    const valueStart = Math.min(valuePosition, basePosition);
    const valueSize = Math.abs(valuePosition - basePosition);
    if (placement.size <= 0 || valueSize <= 0) {
      return null;
    }

    const groupsAreHorizontal = plot.scales.x.ori !== 1;
    const fullHighlight = this.source.barOptions?.fullHighlight && (flags & CompactSeriesFlag.Stack) === 0;
    if (groupsAreHorizontal) {
      return {
        left: placement.start,
        top: fullHighlight ? 0 : valueStart,
        width: placement.size,
        height: fullHighlight ? plot.bbox.height / uPlot.pxRatio : valueSize,
      };
    }
    return {
      left: fullHighlight ? 0 : valueStart,
      top: placement.start,
      width: fullHighlight ? plot.bbox.width / uPlot.pxRatio : valueSize,
      height: placement.size,
    };
  }

  private isCursorSnapshotCurrent(index: number, plot?: uPlot): boolean {
    const cursorPosition = plot ? this.getCursorGroupPosition(plot) : undefined;
    return (
      this.cursorSnapshotIndex === index && (cursorPosition == null || cursorPosition === this.cursorSnapshotMouseX)
    );
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
      this.source.focusOverlayColor == null ||
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
    const { left, top, width, height } = plot.bbox;
    context.save();
    context.fillStyle = this.source.focusOverlayColor;
    context.fillRect(left, top, width, height);
    context.restore();
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
    const hasBars = (flags & CompactSeriesFlag.Bars) !== 0;
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

    if (hasBars) {
      this.drawBars(series, from, to, style);
      if (hasPoints) {
        this.drawPointMarkers(series, from, to, style);
      }
      if ((flags & CompactSeriesFlag.Stack) !== 0) {
        this.operation = ScanOperation.StackCommit;
        this.source.scan(series, from, to, this.visitPoint);
      }
      ctx.restore();
      return;
    }

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
      this.drawPointMarkers(series, from, to, style);
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

  private drawPointMarkers(series: number, from: number, to: number, style: CompactStyleRecord): void {
    const ctx = this.context!;
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

  private drawBars(series: number, from: number, to: number, style: CompactStyleRecord): void {
    const grouped = this.source.barOptions?.mode === 'grouped';
    if (grouped) {
      this.selectGroupedBarSlot(series, this.flags);
    }
    if (!grouped) {
      this.prepareTimeSeriesBarGeometry(series, style);
    }
    this.barRoundOuterEdge =
      (this.flags & CompactSeriesFlag.PercentStack) === 0 &&
      ((this.flags & CompactSeriesFlag.Stack) === 0 || this.isLastVisibleStackBar(series));

    const ctx = this.context!;
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
    this.groupedBarConfiguredStrokeWidth = grouped ? Math.round(Math.max(0, style.lineWidth ?? 1) * uPlot.pxRatio) : 0;
    ctx.lineWidth = grouped ? this.groupedBarConfiguredStrokeWidth : this.barStrokeWidth;
    const showValue = this.source.barOptions?.showValue ?? (style.showValues ? 'always' : 'never');
    this.batchBarPath = !grouped && style.areaGradient == null && showValue === 'never';
    this.hasPath = false;
    if (this.batchBarPath) {
      ctx.beginPath();
    }
    this.operation = ScanOperation.Bars;
    this.source.scan(series, from, to, this.visitPoint);
    if (this.batchBarPath && this.hasPath) {
      const fill = this.getSolidBarFill(style);
      if (fill != null) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (this.barStrokeWidth > 0) {
        ctx.strokeStyle = style.stroke;
        ctx.stroke();
      }
    }
    this.batchBarPath = false;
  }

  private prepareGroupedBarAutoValueFontSize(from: number, to: number): void {
    const options = this.source.barOptions;
    this.groupedBarAutoValueFontSize = null;
    if (
      options?.mode !== 'grouped' ||
      options.valueSize != null ||
      options.showValue === 'never' ||
      !this.source.formatValueAt
    ) {
      return;
    }

    const ctx = this.context!;
    ctx.save();
    try {
      ctx.font = `${14 * uPlot.pxRatio}px ${this.source.valueFontFamily ?? 'sans-serif'}`;
      this.groupedBarAutoValueFontSize = BAR_VALUE_MAX_FONT_SIZE * uPlot.pxRatio;
      for (let series = 0; series < this.source.seriesCount; series++) {
        const flags = this.source.columns.flags[series];
        if (!this.isVisible(series) || (flags & CompactSeriesFlag.Bars) === 0) {
          continue;
        }
        const showValue = options.showValue ?? (this.getStyle(series).showValues ? 'always' : 'never');
        if (showValue === 'never') {
          continue;
        }

        this.seriesIndex = series;
        this.flags = flags;
        this.scaleKey = this.getScaleKey(series);
        this.selectGroupedBarSlot(series, flags);
        this.operation = ScanOperation.BarValueSize;
        this.source.scan(series, from, to, this.visitPoint);
        if ((flags & CompactSeriesFlag.Stack) !== 0) {
          this.operation = ScanOperation.StackCommit;
          this.source.scan(series, from, to, this.visitPoint);
        }
      }
    } finally {
      ctx.restore();
      this.stackScratch.fill(0, 0, this.stackPointCount * this.source.stackGroupCount);
      this.operation = ScanOperation.None;
    }
  }

  private prepareTimeSeriesBarGeometry(series: number, style: CompactStyleRecord): void {
    const plot = this.plot!;
    const xScale = plot.scales.x;
    this.barColumnWidth = xScale.ori === 1 ? plot.bbox.height : plot.bbox.width;
    const widthSample = this.getBarWidthSample(series);
    if (widthSample != null) {
      this.barColumnWidth = Math.abs(
        plot.valToPos(widthSample.timestamp, 'x', true) - plot.valToPos(widthSample.previousTimestamp, 'x', true)
      );
    }

    const factor = Math.max(0, Math.min(1, style.barWidthFactor ?? 0.6));
    let fullGap = this.barColumnWidth * (1 - factor);
    const preliminaryBarWidth = this.barColumnWidth - fullGap;
    if (fullGap < 1) {
      fullGap = 0;
    }

    const pixelIncrement = Number(plot.series?.[series + 1]?.pxAlign ?? 1);
    const configuredPixelRound =
      pixelIncrement === 0
        ? retainPixel
        : pixelIncrement === 1
          ? Math.round
          : (value: number) => Math.round(value / pixelIncrement) * pixelIncrement;
    let strokeWidth = configuredPixelRound(Math.max(0, style.lineWidth ?? 1) * uPlot.pxRatio);
    if (strokeWidth >= preliminaryBarWidth / 2) {
      strokeWidth = 0;
    }

    this.barPixelRound = fullGap < 5 ? retainPixel : configuredPixelRound;
    this.barBaselineRound = this.hasVisibleStackBase(series) ? this.barPixelRound : configuredPixelRound;
    const insetStroke = fullGap > 0;
    const rawBarWidth = this.barColumnWidth - fullGap - (insetStroke ? strokeWidth : 0);
    this.barWidth = this.barPixelRound(
      Math.min(Math.max(uPlot.pxRatio, rawBarWidth), (style.barMaxWidth ?? 200) * uPlot.pxRatio)
    );
    this.barStrokeWidth = strokeWidth;

    const alignment = style.barAlignment ?? 0;
    const direction = (xScale.dir ?? 1) * (xScale.ori === 0 ? 1 : -1);
    this.barShift =
      (alignment === 0 ? this.barWidth / 2 : alignment === direction ? 0 : this.barWidth) -
      alignment * direction * (insetStroke ? strokeWidth / 2 : 0);
  }

  private getBarWidthSample(series: number): CompactBarWidthSample | null {
    if (!this.barWidthSamplesPrepared) {
      this.prepareBarWidthSamples();
    }
    return this.barWidthSamples[series] ?? null;
  }

  private prepareBarWidthSamples(): void {
    const seriesCount = this.source.seriesCount;
    const stackGroups: number[][] = Array.from({ length: this.source.stackGroupCount + 1 }, () => []);
    const cadences = new Set<number>();
    this.barWidthSamples = new Array<CompactBarWidthSample | null>(seriesCount).fill(null);
    this.firstVisibleStackSeries = new Int32Array(this.source.stackGroupCount + 1);
    this.firstVisibleStackSeries.fill(-1);
    this.lastVisibleStackSeries = new Int32Array(this.source.stackGroupCount + 1);
    this.lastVisibleStackSeries.fill(-1);
    let visibleBarCount = 0;
    let globalCadence = Number.POSITIVE_INFINITY;
    let globalSample: CompactBarWidthSample | null = null;

    for (let series = 0; series < seriesCount; series++) {
      const flags = this.source.columns.flags[series];
      if (!this.isVisible(series) || (flags & CompactSeriesFlag.Bars) === 0) {
        continue;
      }
      visibleBarCount++;
      const rawSample = this.findBarWidthSample(series, true);
      if (rawSample != null) {
        const cadence = normalizeBarCadence(rawSample.timestamp - rawSample.previousTimestamp);
        cadences.add(cadence);
        if (cadence < globalCadence) {
          globalCadence = cadence;
          globalSample = rawSample;
        }
      }

      if ((flags & CompactSeriesFlag.Stack) === 0) {
        this.barWidthSamples[series] = this.findBarWidthSample(series, false);
        continue;
      }
      const group = this.getStackGroup(series);
      stackGroups[group].push(series);
      if (this.firstVisibleStackSeries[group] < 0) {
        this.firstVisibleStackSeries[group] = series;
      }
      this.lastVisibleStackSeries[group] = series;
    }

    for (const seriesIndexes of stackGroups) {
      if (seriesIndexes.length > 0) {
        this.prepareStackBarWidthSamples(seriesIndexes);
      }
    }

    if (visibleBarCount > 1 && cadences.size > 1 && globalSample != null) {
      for (let series = 0; series < seriesCount; series++) {
        const flags = this.source.columns.flags[series];
        if (!this.isVisible(series) || (flags & CompactSeriesFlag.Bars) === 0) {
          continue;
        }
        if ((flags & CompactSeriesFlag.Constant) !== 0) {
          continue;
        }
        const sample = this.barWidthSamples[series];
        if (sample == null || normalizeBarCadence(sample.timestamp - sample.previousTimestamp) > globalCadence) {
          this.barWidthSamples[series] = globalSample;
        }
      }
    }
    this.barWidthSamplesPrepared = true;
  }

  private findBarWidthSample(series: number, rawValues: boolean): CompactBarWidthSample | null {
    let previousTimestamp: number | null = null;
    let minimumTimestampDelta = Number.POSITIVE_INFINITY;
    let sample: CompactBarWidthSample | null = null;
    for (let index = 0; index < this.source.pointCount; index++) {
      const value =
        rawValues && this.source.barWidthValueAt
          ? this.source.barWidthValueAt(series, index)
          : this.source.cursorValueAt(series, index);
      if (value === undefined) {
        continue;
      }
      const timestamp = this.source.xAt(index);
      if (previousTimestamp != null) {
        const delta = Math.abs(timestamp - previousTimestamp);
        if (delta < minimumTimestampDelta) {
          minimumTimestampDelta = delta;
          sample = { previousTimestamp, timestamp };
        }
      }
      previousTimestamp = timestamp;
    }
    return sample;
  }

  private prepareStackBarWidthSamples(seriesIndexes: number[]): void {
    const values = new Array<CompactPlotValue>(seriesIndexes.length);
    const previousTimestamps = new Array<number | null>(seriesIndexes.length).fill(null);
    const minimumTimestampDeltas = new Float64Array(seriesIndexes.length).fill(Number.POSITIVE_INFINITY);
    const samples = new Array<CompactBarWidthSample | null>(seriesIndexes.length).fill(null);
    for (let index = 0; index < this.source.pointCount; index++) {
      let stackHasValue = false;
      for (let offset = 0; offset < seriesIndexes.length; offset++) {
        const series = seriesIndexes[offset];
        const value = this.source.cursorValueAt(series, index);
        values[offset] = value;
        const barWidthValue = this.source.barWidthValueAt ? this.source.barWidthValueAt(series, index) : value;
        stackHasValue ||= barWidthValue != null;
      }

      const timestamp = this.source.xAt(index);
      for (let offset = 0; offset < seriesIndexes.length; offset++) {
        if (!stackHasValue && values[offset] === undefined) {
          continue;
        }
        const previousTimestamp = previousTimestamps[offset];
        if (previousTimestamp != null) {
          const delta = Math.abs(timestamp - previousTimestamp);
          if (delta < minimumTimestampDeltas[offset]) {
            minimumTimestampDeltas[offset] = delta;
            samples[offset] = { previousTimestamp, timestamp };
          }
        }
        previousTimestamps[offset] = timestamp;
      }
    }

    for (let offset = 0; offset < seriesIndexes.length; offset++) {
      this.barWidthSamples[seriesIndexes[offset]] = samples[offset];
    }
  }

  private hasVisibleStackBase(series: number): boolean {
    if ((this.source.columns.flags[series] & CompactSeriesFlag.Stack) === 0) {
      return false;
    }
    if (!this.barWidthSamplesPrepared) {
      this.prepareBarWidthSamples();
    }
    const group = this.getStackGroup(series);
    const firstSeries = this.firstVisibleStackSeries[group];
    return firstSeries >= 0 && firstSeries !== series;
  }

  private invalidateBarWidthSamples(): void {
    this.barWidthSamples = [];
    this.barWidthSamplesPrepared = false;
    this.firstVisibleStackSeries = new Int32Array(0);
    this.lastVisibleStackSeries = new Int32Array(0);
  }

  private getConfiguredBarSlot(series: number): { index: number; count: number } {
    return {
      index: Math.max(0, this.barSlots[series] ?? -1),
      count: Math.max(1, this.visibleBarSlotCount),
    };
  }

  private selectGroupedBarSlot(series: number, flags: number): void {
    this.barSlot = 0;
    this.barSlotCount = 1;
    if ((flags & CompactSeriesFlag.Stack) === 0) {
      const slot = this.getConfiguredBarSlot(series);
      this.barSlot = slot.index;
      this.barSlotCount = slot.count;
    }
  }

  private isLastVisibleStackBar(series: number): boolean {
    const group = this.getStackGroup(series);
    if (this.source.barOptions?.mode !== 'grouped') {
      if (!this.barWidthSamplesPrepared) {
        this.prepareBarWidthSamples();
      }
      return this.lastVisibleStackSeries[group] === series;
    }
    for (let candidate = series + 1; candidate < this.source.seriesCount; candidate++) {
      if (
        this.isVisible(candidate) &&
        (this.source.columns.flags[candidate] & CompactSeriesFlag.Bars) !== 0 &&
        this.getStackGroup(candidate) === group
      ) {
        return false;
      }
    }
    return true;
  }

  private visitBarValueSize(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    if (rawValue == null) {
      return;
    }

    const value = this.renderValue(index, rawValue, false);
    const base = this.currentStackBase;
    const valuePosition = this.plot!.valToPos(value, this.scaleKey, true);
    const basePosition = this.plot!.valToPos(base, this.scaleKey, true);
    const { center, size: bandSize } = this.getBarBandForPlot(this.plot!, index, timestamp, true);
    const { start: bandStart, size: barSize } = this.getGroupedBarPlacement(center, bandSize);
    const valueStart = Math.min(valuePosition, basePosition);
    const valueSize = Math.abs(valuePosition - basePosition);
    const horizontalGroups = this.plot!.scales.x.ori !== 1;
    const x = horizontalGroups ? bandStart : valueStart;
    const y = horizontalGroups ? valueStart : bandStart;
    const width = horizontalGroups ? barSize : valueSize;
    const height = horizontalGroups ? valueSize : barSize;
    let labelValue = rawValue;
    if ((this.flags & CompactSeriesFlag.PercentStack) !== 0) {
      const total = this.stackTotals[this.getStackScratchIndex(index)];
      labelValue = total === 0 ? 0 : rawValue / total;
    }
    const text = this.source.formatValueAt!(this.seriesIndex, index, labelValue);
    this.groupedBarAutoValueFontSize = Math.min(
      this.groupedBarAutoValueFontSize!,
      this.calculateAutoBarValueFontSize(text, rawValue, x, y, width, height, horizontalGroups)
    );
  }

  private visitBar(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    if (rawValue == null) {
      return;
    }

    const style = this.getStyle(this.seriesIndex);
    const value = this.renderValue(index, rawValue, false);
    const base = this.currentStackBase;
    const scaleKey = this.scaleKey;
    const grouped = this.source.barOptions?.mode === 'grouped';
    let valuePosition = this.plot!.valToPos(value, scaleKey, true);
    let basePosition = this.plot!.valToPos(base, scaleKey, true);
    let bandStart: number;
    let barSize: number;
    let groupedBandSize = 0;
    if (grouped) {
      const { center, size: bandSize } = this.getBarBandForPlot(this.plot!, index, timestamp, true);
      groupedBandSize = bandSize;
      ({ start: bandStart, size: barSize } = this.getGroupedBarPlacement(center, bandSize));
    } else {
      valuePosition = this.barPixelRound(valuePosition);
      basePosition = this.barBaselineRound(basePosition);
      bandStart = this.barPixelRound(this.plot!.valToPos(timestamp, 'x', true) - this.barShift);
      barSize = this.barWidth;
    }
    const outerBandStart = bandStart;
    const outerBarSize = barSize;
    const outerValueStart = Math.min(valuePosition, basePosition);
    const outerValueSize = Math.abs(valuePosition - basePosition);
    const valueAtStart = valuePosition <= basePosition;
    let strokeWidth = grouped ? this.groupedBarConfiguredStrokeWidth : this.barStrokeWidth;
    if (grouped && strokeWidth >= barSize / 2) {
      strokeWidth = 0;
    }
    this.groupedBarStrokeSuppressed = grouped && this.groupedBarConfiguredStrokeWidth > 0 && strokeWidth === 0;
    if (grouped && strokeWidth > 0) {
      if (barSize < groupedBandSize) {
        bandStart += strokeWidth / 2;
        barSize = Math.max(0, barSize - strokeWidth);
      }
      const pathStart = outerValueStart + Math.floor(strokeWidth / 2);
      const pathEnd = pathStart + Math.max(0, outerValueSize - strokeWidth);
      valuePosition = valueAtStart ? pathStart : pathEnd;
      basePosition = valueAtStart ? pathEnd : pathStart;
      this.context!.lineWidth = strokeWidth;
    }
    const strokeInset = grouped ? 0 : Math.floor(strokeWidth / 2);
    const valueStart = grouped ? Math.min(valuePosition, basePosition) : outerValueStart + strokeInset;
    const valueSize = grouped ? Math.abs(valuePosition - basePosition) : Math.max(0, outerValueSize - strokeWidth);
    const xScale = this.plot!.scales.x;
    const horizontalGroups = xScale?.ori !== 1;
    const x = horizontalGroups ? bandStart : valueStart;
    const y = horizontalGroups ? valueStart : bandStart;
    const width = horizontalGroups ? barSize : valueSize;
    const height = horizontalGroups ? valueSize : barSize;

    if ((grouped && (width < 0 || height < 0)) || (!grouped && (width <= 0 || height <= 0))) {
      return;
    }

    const ctx = this.context!;
    const radius = this.barRoundOuterEdge
      ? Math.min((this.source.barOptions?.barRadius ?? 0) * Math.min(width, height), Math.min(width, height) / 2)
      : 0;
    if (!this.batchBarPath) {
      ctx.beginPath();
    }
    addRoundedRect(ctx, x, y, width, height, radius, horizontalGroups, rawValue < 0);
    if (this.batchBarPath) {
      this.hasPath = true;
    } else {
      const fill = this.getBarFill(style, valuePosition, basePosition, horizontalGroups);
      if (fill != null) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (strokeWidth > 0) {
        ctx.strokeStyle = style.stroke;
        ctx.stroke();
      }
    }

    if (!this.batchBarPath) {
      let labelValue = rawValue;
      if ((this.flags & CompactSeriesFlag.PercentStack) !== 0) {
        const total = this.stackTotals[this.getStackScratchIndex(index)];
        labelValue = total === 0 ? 0 : rawValue / total;
      }
      const labelX = grouped ? (horizontalGroups ? outerBandStart : outerValueStart) : x;
      const labelY = grouped ? (horizontalGroups ? outerValueStart : outerBandStart) : y;
      const labelWidth = grouped ? (horizontalGroups ? outerBarSize : outerValueSize) : width;
      const labelHeight = grouped ? (horizontalGroups ? outerValueSize : outerBarSize) : height;
      this.drawBarValueLabel(index, labelValue, rawValue, labelX, labelY, labelWidth, labelHeight, horizontalGroups);
    }
  }

  private getBarBandForPlot(
    plot: uPlot,
    index: number,
    timestamp: number,
    canvasPixels: boolean
  ): { center: number; size: number } {
    const pointCount = this.source.pointCount;
    const scale = plot.scales.x;
    const rawDimension = scale?.ori === 1 ? plot.bbox.height : plot.bbox.width;
    const dimension = canvasPixels ? rawDimension : rawDimension / uPlot.pxRatio;
    if (this.source.barOptions?.mode === 'grouped') {
      const groupWidth = this.groupedBarGroupWidth;
      const groupSize = groupWidth / Math.max(1, pointCount);
      const gapSize = pointCount > 1 ? (1 - groupWidth) / (pointCount - 1) : 0;
      const ordinalPosition = index * (groupSize + gapSize) + groupSize / 2;
      const position =
        scale?.ori === 1
          ? scale.dir === -1
            ? ordinalPosition
            : 1 - ordinalPosition
          : scale?.dir === -1
            ? 1 - ordinalPosition
            : ordinalPosition;
      const offset = canvasPixels ? (scale?.ori === 1 ? plot.bbox.top : plot.bbox.left) : 0;
      return { center: offset + dimension * position, size: dimension / Math.max(1, pointCount) };
    }
    const center = plot.valToPos(timestamp, 'x', canvasPixels);
    if (pointCount <= 1) {
      return { center, size: dimension };
    }

    const previous =
      index > 0
        ? plot.valToPos(this.source.xAt(index - 1), 'x', canvasPixels)
        : center - (plot.valToPos(this.source.xAt(Math.min(pointCount - 1, index + 1)), 'x', canvasPixels) - center);
    const next =
      index < pointCount - 1
        ? plot.valToPos(this.source.xAt(index + 1), 'x', canvasPixels)
        : center + (center - plot.valToPos(this.source.xAt(Math.max(0, index - 1)), 'x', canvasPixels));
    return { center, size: Math.max(1, Math.min(Math.abs(center - previous), Math.abs(next - center))) };
  }

  private getGroupedBarPlacement(
    center: number,
    bandSize: number,
    pixelRatio = uPlot.pxRatio
  ): { start: number; size: number } {
    const barWidth = this.groupedBarWidth;
    const groupWidthFactor = this.groupedBarGroupWidth;
    if ((this.flags & CompactSeriesFlag.Stack) !== 0) {
      const size = this.clampBarSize(bandSize * groupWidthFactor, Number.POSITIVE_INFINITY, pixelRatio);
      return { start: center - size / 2, size };
    }
    const groupWidth = bandSize * groupWidthFactor;
    const slotCount = Math.max(1, this.barSlotCount);
    const barFraction = barWidth / slotCount;
    const gapFraction = slotCount > 1 ? (1 - barWidth) / (slotCount - 1) : 0;
    const size = this.clampBarSize(groupWidth * barFraction, Number.POSITIVE_INFINITY, pixelRatio);
    const start = center - groupWidth / 2 + groupWidth * this.barSlot * (barFraction + gapFraction);
    return { start, size };
  }

  private clampBarSize(size: number, maxWidth: number, pixelRatio: number): number {
    return Math.min(Math.max(pixelRatio, size), maxWidth * pixelRatio);
  }

  private getBarFill(
    style: CompactStyleRecord,
    valuePosition: number,
    basePosition: number,
    horizontalGroups: boolean
  ): string | CanvasGradient | null | undefined {
    if (this.shouldFillBarsWithStroke(style)) {
      return style.stroke;
    }
    if (style.areaGradient == null) {
      return style.areaFill;
    }
    const gradient = horizontalGroups
      ? this.context!.createLinearGradient(0, valuePosition, 0, basePosition)
      : this.context!.createLinearGradient(valuePosition, 0, basePosition, 0);
    gradient.addColorStop(0, style.areaGradient[0]);
    gradient.addColorStop(1, style.areaGradient[1]);
    return gradient;
  }

  private getSolidBarFill(style: CompactStyleRecord): string | undefined {
    return this.shouldFillBarsWithStroke(style) ? style.stroke : (style.areaFill ?? undefined);
  }

  private shouldFillBarsWithStroke(style: CompactStyleRecord): boolean {
    return (
      (this.source.barOptions?.mode === 'grouped' ? this.groupedBarStrokeSuppressed : this.barStrokeWidth === 0) &&
      (style.lineWidth ?? 1) > 0
    );
  }

  private drawBarValueLabel(
    index: number,
    value: number,
    rawValue: number,
    x: number,
    y: number,
    width: number,
    height: number,
    horizontalGroups: boolean
  ): void {
    const options = this.source.barOptions;
    const showValue = options?.showValue ?? (this.getStyle(this.seriesIndex).showValues ? 'always' : 'never');
    if (showValue === 'never' || !this.source.formatValueAt) {
      return;
    }

    const text = this.source.formatValueAt(this.seriesIndex, index, value);
    const ctx = this.context!;
    ctx.save();
    const plotBounds = this.plot!.bbox;
    let fontSize: number;
    if (options?.valueSize != null) {
      fontSize = Math.max(1, options.valueSize) * uPlot.pxRatio;
    } else if (options?.mode === 'grouped') {
      fontSize = this.groupedBarAutoValueFontSize ?? BAR_VALUE_MAX_FONT_SIZE * uPlot.pxRatio;
      if (fontSize < BAR_VALUE_MIN_FONT_SIZE * uPlot.pxRatio) {
        ctx.restore();
        return;
      }
    } else {
      fontSize = 12 * uPlot.pxRatio;
    }
    ctx.font = `${fontSize}px ${this.source.valueFontFamily ?? 'sans-serif'}`;
    const metrics = ctx.measureText(text);
    const textHeight = fontSize;
    const labelFitsGroup = horizontalGroups ? metrics.width <= width : textHeight <= height;
    const labelFitsPlot = horizontalGroups
      ? rawValue < 0
        ? y + height + 5 + textHeight <= plotBounds.top + plotBounds.height
        : y - 5 - textHeight >= plotBounds.top
      : rawValue < 0
        ? x - 5 - metrics.width >= plotBounds.left
        : x + width + 5 + metrics.width <= plotBounds.left + plotBounds.width;
    if (!labelFitsGroup || !labelFitsPlot) {
      ctx.restore();
      return;
    }

    const bounds: CompactRect = horizontalGroups
      ? {
          left: x + (width - metrics.width) / 2,
          top: rawValue < 0 ? y + height + 5 : y - 5 - textHeight,
          width: metrics.width,
          height: textHeight,
        }
      : {
          left: rawValue < 0 ? x - 5 - metrics.width : x + width + 5,
          top: y + (height - textHeight) / 2,
          width: metrics.width,
          height: textHeight,
        };
    if (showValue === 'auto') {
      const existing = this.barLabelBounds.get(index);
      if (existing?.some((candidate) => rectsIntersect(candidate, bounds))) {
        ctx.restore();
        return;
      }
      if (existing) {
        existing.push(bounds);
      } else {
        this.barLabelBounds.set(index, [bounds]);
      }
    }

    ctx.fillStyle = this.source.valueColor ?? this.getStyle(this.seriesIndex).stroke;
    if (horizontalGroups) {
      ctx.textAlign = 'center';
      ctx.textBaseline = rawValue < 0 ? 'top' : 'bottom';
      ctx.fillText(text, x + width / 2, rawValue < 0 ? y + height + 5 : y - 5);
    } else {
      ctx.textAlign = rawValue < 0 ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, rawValue < 0 ? x - 5 : x + width + 5, y + height / 2);
    }
    ctx.restore();
  }

  private calculateAutoBarValueFontSize(
    text: string,
    rawValue: number,
    x: number,
    y: number,
    width: number,
    height: number,
    horizontalGroups: boolean
  ): number {
    const measurementSize = 14 * uPlot.pxRatio;
    const measuredWidth = this.context!.measureText(text).width;
    const plotBounds = this.plot!.bbox;
    const outsideSpace = horizontalGroups
      ? rawValue < 0
        ? plotBounds.top + plotBounds.height - (y + height) - 5
        : y - plotBounds.top - 5
      : rawValue < 0
        ? x - plotBounds.left - 5
        : plotBounds.left + plotBounds.width - (x + width) - 5;
    const availableWidth = horizontalGroups ? width * BAR_VALUE_FIT_RATIO : outsideSpace;
    const availableHeight = horizontalGroups ? outsideSpace : height * BAR_VALUE_FIT_RATIO;
    return Math.round(
      Math.min(
        BAR_VALUE_MAX_FONT_SIZE * uPlot.pxRatio,
        availableHeight,
        (availableWidth * measurementSize) / (measuredWidth + 2 * uPlot.pxRatio)
      )
    );
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
    return this.plot!.valToPos(this.getFillBaselineValue(this.plot!, this.scaleKey), this.scaleKey, true);
  }

  private getFillBaselineValue(plot: uPlot, scaleKey: string): number {
    const scale = plot.scales[scaleKey];
    return scale?.distr === 3 ? ((scale.dir === 1 ? scale.min : scale.max) ?? 0) : 0;
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

  private visitStackTotal(index: number, rawValue: CompactPlotValue): void {
    if (rawValue == null) {
      return;
    }
    const scratchIndex = this.getStackScratchIndex(index);
    this.stackPresence[scratchIndex] = 1;
    this.stackTotals[scratchIndex] += rawValue;
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
    this.currentStackBase = this.normalizeStackValue(scratchIndex, base);
    if (updateStack) {
      this.stackScratch[scratchIndex] = base + value;
    }
    return this.normalizeStackValue(scratchIndex, base + value);
  }

  private normalizeStackValue(scratchIndex: number, value: number): number {
    if ((this.flags & CompactSeriesFlag.PercentStack) === 0) {
      return value;
    }
    const total = Math.abs(this.stackTotals[scratchIndex]);
    return total === 0 ? 0 : value / total;
  }

  private commitStackValue(index: number, value: number): void {
    this.renderValue(index, value, true);
  }

  private getStackBase(index: number): number {
    const scratchIndex = this.getStackScratchIndex(index);
    return this.normalizeStackValue(scratchIndex, this.stackScratch[scratchIndex]);
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
      this.currentCursorStackBase = 0;
      return value;
    }
    const group = this.getStackGroup(series);
    const firstSlot = (group - 1) * CURSOR_STACK_CACHE_SIZE;
    const lastSlot = firstSlot + CURSOR_STACK_CACHE_SIZE;
    let slot = -1;
    let emptySlot = -1;
    for (let candidateSlot = firstSlot; candidateSlot < lastSlot; candidateSlot++) {
      const cachedIndex = this.cursorStackIndexes[candidateSlot];
      if (cachedIndex === dataIndex) {
        slot = candidateSlot;
        break;
      }
      if (cachedIndex < 0 && emptySlot < 0) {
        emptySlot = candidateSlot;
      }
    }

    if (slot < 0 && emptySlot >= 0) {
      slot = emptySlot;
      this.cursorStackIndexes[slot] = dataIndex;
      this.cursorStackNextSeries[slot] = 0;
      this.cursorStacks[slot] = 0;
      this.cursorStackTotals[slot] = this.calculateCursorStackTotal(group, dataIndex);
    }

    let stackedValue = slot < 0 ? 0 : this.cursorStacks[slot];
    const firstSeries = slot < 0 ? 0 : this.cursorStackNextSeries[slot];
    for (let candidate = firstSeries; candidate < series; candidate++) {
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
    const stackBase = stackedValue;
    stackedValue += value;
    if (slot >= 0) {
      this.cursorStacks[slot] = stackedValue;
      this.cursorStackNextSeries[slot] = series + 1;
    }
    if ((this.source.columns.flags[series] & CompactSeriesFlag.PercentStack) === 0) {
      this.currentCursorStackBase = stackBase;
      return stackedValue;
    }
    const total = slot < 0 ? this.calculateCursorStackTotal(group, dataIndex) : this.cursorStackTotals[slot];
    const absoluteTotal = Math.abs(total);
    this.currentCursorStackBase = absoluteTotal === 0 ? 0 : stackBase / absoluteTotal;
    return absoluteTotal === 0 ? 0 : stackedValue / absoluteTotal;
  }

  private calculateCursorStackTotal(group: number, dataIndex: number): number {
    let total = 0;
    for (let series = 0; series < this.source.seriesCount; series++) {
      if (!this.isVisible(series) || this.getStackGroup(series) !== group) {
        continue;
      }
      const value = this.source.yAt(series, dataIndex);
      if (value != null) {
        total += value;
      }
    }
    return total;
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
    if (this.stackTotals.length < required) {
      this.stackTotals = new Float64Array(required);
    } else {
      this.stackTotals.fill(0, 0, required);
    }
    this.operation = ScanOperation.StackTotal;
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
    const required = this.source.stackGroupCount * CURSOR_STACK_CACHE_SIZE;
    if (this.cursorStacks.length !== required) {
      this.cursorStacks = new Float64Array(required);
      this.cursorStackTotals = new Float64Array(required);
      this.cursorStackIndexes = new Int32Array(required);
      this.cursorStackNextSeries = new Int32Array(required);
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
    this.cursorSnapshotMouseX = plot ? (this.getCursorGroupPosition(plot) ?? Number.NaN) : Number.NaN;
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
    const cursorPosition = this.requireCursorGroupPosition(plot);
    const leftDistance = cursorPosition - plot.valToPos(source.xAt(left), 'x');
    const rightDistance = plot.valToPos(source.xAt(right), 'x') - cursorPosition;

    if (leftDistance <= rightDistance) {
      return this.isWithinCursorProximity(plot, seriesIndex, index, left) ? left : null;
    }
    return this.isWithinCursorProximity(plot, seriesIndex, index, right) ? right : null;
  }

  private isWithinCursorProximity(plot: uPlot, seriesIndex: number, hoveredIndex: number, dataIndex: number): boolean {
    const maxDistance = this.getCursorProximity(plot, seriesIndex, hoveredIndex);
    return (
      maxDistance == null ||
      Math.abs(this.requireCursorGroupPosition(plot) - plot.valToPos(this.source.xAt(dataIndex), 'x')) <= maxDistance
    );
  }

  private getCursorProximity(plot: uPlot, seriesIndex: number, hoveredIndex: number): number | null {
    const proximity = plot.cursor.hover?.prox;
    const maxDistance =
      typeof proximity === 'function'
        ? proximity(plot, seriesIndex + 1, hoveredIndex, plot.posToVal(this.requireCursorGroupPosition(plot), 'x'))
        : proximity;
    return maxDistance == null || maxDistance < 0 || !Number.isFinite(maxDistance) ? null : maxDistance;
  }

  private getCursorGroupPosition(plot: uPlot): number | null | undefined {
    return plot.scales.x.ori === 1 ? plot.cursor.top : plot.cursor.left;
  }

  private requireCursorGroupPosition(plot: uPlot): number {
    const position = this.getCursorGroupPosition(plot);
    if (position == null) {
      throw new Error('Compact cursor resolution requires a position on the group axis');
    }
    return position;
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

export function hasCompatibleCompactRenderSource(previous: CompactRenderSource, next: CompactRenderSource): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.barOptions?.mode !== next.barOptions?.mode || previous.scales.length !== next.scales.length) {
    return false;
  }
  for (let index = 0; index < previous.scales.length; index++) {
    if (JSON.stringify(previous.scales[index]) !== JSON.stringify(next.scales[index])) {
      return false;
    }
  }
  return percentScaleUsageEqual(previous, next);
}

function validateCompatibleSource(previous: CompactRenderSource, next: CompactRenderSource): void {
  validateSource(next);
  if (hasCompatibleCompactRenderSource(previous, next)) {
    return;
  }
  if (previous.barOptions?.mode !== next.barOptions?.mode) {
    throw new Error('Compact source replacement changed grouped-bar mode');
  }
  if (previous.scales.length !== next.scales.length) {
    throw new Error('Compact source replacement changed scale topology');
  }
  for (let index = 0; index < previous.scales.length; index++) {
    if (JSON.stringify(previous.scales[index]) !== JSON.stringify(next.scales[index])) {
      throw new Error('Compact source replacement changed scale identity');
    }
  }
  throw new Error('Compact source replacement changed percent scale usage');
}

function percentScaleUsageEqual(previous: CompactRenderSource, next: CompactRenderSource): boolean {
  const previousPercentScales = new Uint8Array(previous.scales.length);
  const nextPercentScales = new Uint8Array(next.scales.length);
  for (let index = 0; index < previous.seriesCount; index++) {
    if ((previous.columns.flags[index] & CompactSeriesFlag.PercentStack) !== 0) {
      previousPercentScales[previous.columns.scaleIds[index]] = 1;
    }
  }
  for (let index = 0; index < next.seriesCount; index++) {
    if ((next.columns.flags[index] & CompactSeriesFlag.PercentStack) !== 0) {
      nextPercentScales[next.columns.scaleIds[index]] = 1;
    }
  }
  return columnsEqual(previousPercentScales, nextPercentScales);
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

export function transferCompactVisibilityState(previous: CompactRenderSource, next: CompactRenderSource): number {
  validateCompatibleSource(previous, next);
  copyVisibilityState(previous.visibilityState, next.visibilityState);
  return applyCompactVisibilityState(next);
}

function applyCompactVisibilityState(source: CompactRenderSource): number {
  const state = source.visibilityState;
  if (state.globalVisibility != null) {
    for (let seriesIndex = 0; seriesIndex < source.seriesCount; seriesIndex++) {
      source.columns.visibility[seriesIndex] =
        state.globalVisibility === 1 ? (source.barLayoutVisibility?.[seriesIndex] ?? 1) : 0;
    }
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
        source.columns.visibility[seriesIndex] =
          override.visibility === 1 ? (source.barLayoutVisibility?.[seriesIndex] ?? 1) : 0;
      }
    }
  }
  let visibleSeriesCount = 0;
  for (let seriesIndex = 0; seriesIndex < source.seriesCount; seriesIndex++) {
    if (source.barLayoutVisibility?.[seriesIndex] === 0) {
      source.columns.visibility[seriesIndex] = 0;
    }
    visibleSeriesCount += source.columns.visibility[seriesIndex] === 1 ? 1 : 0;
  }
  return visibleSeriesCount;
}

function addRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  groupsAreHorizontal: boolean,
  negative: boolean
): void {
  if (radius <= 0) {
    context.rect(x, y, width, height);
    return;
  }
  const right = x + width;
  const bottom = y + height;
  const roundTop = groupsAreHorizontal && !negative;
  const roundRight = !groupsAreHorizontal && !negative;
  const roundBottom = groupsAreHorizontal && negative;
  const roundLeft = !groupsAreHorizontal && negative;
  const topLeft = roundTop || roundLeft ? radius : 0;
  const topRight = roundTop || roundRight ? radius : 0;
  const bottomRight = roundBottom || roundRight ? radius : 0;
  const bottomLeft = roundBottom || roundLeft ? radius : 0;

  context.moveTo(x + topLeft, y);
  context.lineTo(right - topRight, y);
  if (topRight > 0) {
    context.quadraticCurveTo(right, y, right, y + topRight);
  }
  context.lineTo(right, bottom - bottomRight);
  if (bottomRight > 0) {
    context.quadraticCurveTo(right, bottom, right - bottomRight, bottom);
  }
  context.lineTo(x + bottomLeft, bottom);
  if (bottomLeft > 0) {
    context.quadraticCurveTo(x, bottom, x, bottom - bottomLeft);
  }
  context.lineTo(x, y + topLeft);
  if (topLeft > 0) {
    context.quadraticCurveTo(x, y, x + topLeft, y);
  }
  context.closePath();
}

function rectsIntersect(left: CompactRect, right: CompactRect): boolean {
  return (
    left.left < right.left + right.width &&
    left.left + left.width > right.left &&
    left.top < right.top + right.height &&
    left.top + left.height > right.top
  );
}

function rectContains(
  rect: CompactRect,
  groupPosition: number,
  valuePosition: number,
  groupAxisVertical: boolean
): boolean {
  const x = groupAxisVertical ? valuePosition : groupPosition;
  const y = groupAxisVertical ? groupPosition : valuePosition;
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
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
    if ((columns.flags[series] & CompactSeriesFlag.PercentStack) !== 0 && !stacked) {
      throw new Error('Compact renderer percent stacking requires stack metadata');
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
