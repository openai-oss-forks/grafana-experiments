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

interface CompactBarGeometry extends CompactRect {
  readonly outerBandStart: number;
  readonly outerBarSize: number;
  readonly outerValueStart: number;
  readonly outerValueSize: number;
  readonly valuePosition: number;
  readonly basePosition: number;
  readonly horizontalGroups: boolean;
  readonly strokeWidth: number;
  readonly groupedStrokeSuppressed: boolean;
}

interface CompactAreaSample {
  readonly index: number;
  readonly groupPosition: number;
  readonly top: number;
  readonly base: number;
}

interface CompactGroupedBarSplitOptions {
  maximumCount?: number;
  anchorEnd?: boolean;
  reverse?: boolean;
}

type CompactAreaPoint = Pick<CompactAreaSample, 'groupPosition' | 'top'>;

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
  readonly stackDirections?: Int8Array;
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
  PreciseGeometry,
  BarBody,
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
  StackSubtract,
  StackCommit,
  ValueLabel,
  DecimatedLine,
}

const controllers = new WeakMap<CompactRenderSource, CompactRenderController>();
const PROGRESSIVE_SAMPLE_THRESHOLD = 32_000;
const LONG_SERIES_PROGRESSIVE_SAMPLE_THRESHOLD = 1_000_000;
const PROGRESSIVE_POINT_BUDGET = 8_000;
const PROGRESSIVE_TASKS_PER_TURN = 4;
const PROGRESSIVE_TURN_BUDGET_MS = 8;
const PROGRESSIVE_INPUT_YIELD_DELAY_MS = 8;
const MAX_CONSECUTIVE_INPUT_YIELDS = 4;
const MAX_GROUPED_BAR_SPLITS = 2_048;
const CURSOR_STACK_CACHE_SIZE = 4;
const MAX_STACK_FOCUS_CHECKPOINTS = 32;
const TARGET_STACK_FOCUS_CHECKPOINT_VALUES = (256 * 1024) / Float64Array.BYTES_PER_ELEMENT;
const MAX_STACK_FOCUS_CHECKPOINT_VALUES = (320 * 1024) / Float64Array.BYTES_PER_ELEMENT;
const MAX_SYNC_FOCUS_STACK_SAMPLES = 32_000;
const BAR_VALUE_MIN_FONT_SIZE = 8;
const BAR_VALUE_MAX_FONT_SIZE = 30;
const BAR_VALUE_FIT_RATIO = 0.65;
const retainPixel = (value: number) => value;
const interpolate = (from: number, to: number, fraction: number) => from + (to - from) * fraction;
const hoverStageProbe = getCompactHoverStageProbe();

type ProgressiveDrawTask = () => boolean;

const progressiveDrawQueue = new Set<ProgressiveDrawTask>();
let progressiveDrawTimer: number | undefined;
let consecutiveInputYields = 0;

function scheduleProgressiveDraw(task: ProgressiveDrawTask): void {
  progressiveDrawQueue.add(task);
  scheduleProgressiveDrawTurn();
}

function cancelScheduledProgressiveDraw(task: ProgressiveDrawTask): void {
  progressiveDrawQueue.delete(task);
  if (progressiveDrawQueue.size === 0 && progressiveDrawTimer != null) {
    window.clearTimeout(progressiveDrawTimer);
    progressiveDrawTimer = undefined;
    consecutiveInputYields = 0;
  }
}

function scheduleProgressiveDrawTurn(delay = 0): void {
  if (progressiveDrawTimer != null || progressiveDrawQueue.size === 0) {
    return;
  }
  progressiveDrawTimer = window.setTimeout(runProgressiveDrawTurn, delay);
}

function runProgressiveDrawTurn(): void {
  progressiveDrawTimer = undefined;
  const deadline = performance.now() + PROGRESSIVE_TURN_BUDGET_MS;
  let completedTasks = 0;
  let yieldedForInput = false;
  try {
    while (progressiveDrawQueue.size > 0 && completedTasks < PROGRESSIVE_TASKS_PER_TURN) {
      const task = progressiveDrawQueue.values().next().value;
      if (!task) {
        break;
      }
      if (hasPendingInput() && consecutiveInputYields < MAX_CONSECUTIVE_INPUT_YIELDS) {
        consecutiveInputYields++;
        yieldedForInput = true;
        break;
      }
      consecutiveInputYields = 0;
      progressiveDrawQueue.delete(task);
      if (task()) {
        progressiveDrawQueue.add(task);
      }
      completedTasks++;
      if (performance.now() >= deadline) {
        break;
      }
    }
  } finally {
    if (progressiveDrawQueue.size === 0) {
      consecutiveInputYields = 0;
    }
    scheduleProgressiveDrawTurn(yieldedForInput ? PROGRESSIVE_INPUT_YIELD_DELAY_MS : 0);
  }
}

function hasPendingInput(): boolean {
  const scheduling: unknown = Reflect.get(window.navigator, 'scheduling');
  if (scheduling == null || typeof scheduling !== 'object') {
    return false;
  }
  const isInputPending: unknown = Reflect.get(scheduling, 'isInputPending');
  if (typeof isInputPending !== 'function') {
    return false;
  }
  try {
    return isInputPending.call(scheduling, { includeContinuous: true }) === true;
  } catch {
    return false;
  }
}

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
  let visibleSeriesCount = 0;
  for (let series = 0; series < source.seriesCount; series++) {
    if (source.columns.visibility[series] !== 1) {
      continue;
    }
    visibleSeriesCount++;
    if (!canDrawCompactSeriesProgressively(source, series)) {
      return false;
    }
  }
  const shortRangePointCount = Math.min(source.pointCount, PROGRESSIVE_POINT_BUDGET);
  return (
    visibleSeriesCount * shortRangePointCount >= progressiveSampleThreshold(shortRangePointCount) ||
    visibleSeriesCount * source.pointCount >= progressiveSampleThreshold(source.pointCount)
  );
}

function progressiveSampleThreshold(pointCount: number): number {
  return pointCount <= PROGRESSIVE_POINT_BUDGET
    ? PROGRESSIVE_SAMPLE_THRESHOLD
    : LONG_SERIES_PROGRESSIVE_SAMPLE_THRESHOLD;
}

function canDrawCompactSeriesProgressively(
  source: CompactRenderSource,
  series: number,
  autoPointsVisible = false
): boolean {
  const flags = source.columns.flags[series];
  const style = source.styles[source.columns.styleIds[series]];
  if ((flags & CompactSeriesFlag.Bars) !== 0) {
    return (flags & (CompactSeriesFlag.DrawLine | CompactSeriesFlag.Points)) === 0 && style.areaGradient == null;
  }
  return (
    (flags & CompactSeriesFlag.PathMask) === CompactSeriesFlag.Linear &&
    (flags & CompactSeriesFlag.DrawLine) !== 0 &&
    (flags & (CompactSeriesFlag.Points | CompactSeriesFlag.Stack)) === 0 &&
    !autoPointsVisible &&
    style.areaFill == null &&
    style.areaGradient == null &&
    (style.lineDash?.length ?? 0) === 0 &&
    (style.alpha ?? 1) === 1 &&
    style.showValues !== true
  );
}

/**
 * uPlot integration point for binary-native rendering. All retained state is constant-sized or keyed by
 * unique scales/styles/stack groups rather than by samples or series.
 */
export class CompactRenderController implements uPlot.CompactRenderController {
  private sourceRevision = 0;
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
  private focusStackScratch = new Float64Array(0);
  private focusStackGroup = 0;
  private focusStackSeries = -1;
  private focusStackSuffixStable = true;
  private focusFrameReady = false;
  private focusStackCheckpoints = new Float64Array(0);
  private focusStackCheckpointSeries = new Int32Array(0);
  private focusStackCheckpointGroupOffsets = new Int32Array(0);
  private focusStackCheckpointGroupCounts = new Int32Array(0);
  private focusStackCheckpointGroupStrides = new Int32Array(0);
  private focusStackCheckpointGroupProgress = new Int32Array(0);
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
  private cursorSnapshotPositionSensitive = false;
  private cursorSnapshotBarBodyPresent = false;
  private cursorSnapshotBarSeriesIndex = -1;
  private cursorSnapshotBarDataIndex = -1;
  private cursorTargetPriority = CursorTargetPriority.DistantGeometry;
  private cursorTargetDistance = Number.POSITIVE_INFINITY;
  private cursorBarBodyPresent = false;
  private cursorBarSeriesIndex = -1;
  private cursorBarDataIndex = -1;
  private readonly cursorAreaVertexCache = new Map<number, number | null>();
  private readonly cursorStackPresenceCache = new Map<number, boolean>();
  private readonly cursorAreaSamples: CompactAreaSample[] = [];
  private readonly cursorSnapshot: MutableCompactCursorSnapshot;
  private gradientCache: Array<CanvasGradient | undefined> = [];
  private stackFrom = 0;
  private stackPointCount = 0;
  private progressiveGeneration = 0;
  private progressiveTask: ProgressiveDrawTask | undefined;
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
      case ScanOperation.StackSubtract:
        this.visitStackSubtract(index, value);
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

  isProgressiveDrawInFlight(): boolean {
    return this.resolveProgressiveDraw !== undefined;
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

  groupedBarRevision(): number {
    return this.sourceRevision;
  }

  groupedBarTimestampSamples(maximumCount = 128): number[] {
    const pointCount = this.source.pointCount;
    if (pointCount === 0 || maximumCount <= 0) {
      return [];
    }
    const sampleCount = Math.min(pointCount, Math.floor(maximumCount));
    return Array.from({ length: sampleCount }, (_, sample) => {
      const index = sampleCount === 1 ? 0 : Math.round((sample * (pointCount - 1)) / (sampleCount - 1));
      return this.source.xAt(index);
    });
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

  groupedBarSplits(minimum: number, maximum: number, options: CompactGroupedBarSplitOptions = {}): number[] {
    const pointCount = this.source.pointCount;
    if (pointCount === 0) {
      return [];
    }
    const from = Math.max(0, Math.ceil(this.groupedBarIndexAt(minimum)));
    const to = Math.min(pointCount - 1, Math.floor(this.groupedBarIndexAt(maximum)));
    if (from > to) {
      return [];
    }
    const visibleCount = to - from + 1;
    const requestedMaximum =
      options.maximumCount == null ? MAX_GROUPED_BAR_SPLITS : Math.max(1, Math.floor(options.maximumCount));
    const maximumCount = Math.min(visibleCount, MAX_GROUPED_BAR_SPLITS, requestedMaximum);
    const skip = visibleCount < maximumCount ? 1 : Math.ceil(visibleCount / maximumCount);
    const firstOffset = options.anchorEnd ? (visibleCount - 1) % skip : 0;
    const splitCount = Math.floor((visibleCount - 1 - firstOffset) / skip) + 1;
    const splits = new Array<number>(splitCount);
    for (let split = 0; split < splitCount; split++) {
      splits[split] = this.source.xAt(from + firstOffset + split * skip);
    }
    return options.reverse ? splits.reverse() : splits;
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
    if (controllers.get(previousSource) === this) {
      controllers.delete(previousSource);
    }
    this.source = nextSource;
    this.sourceRevision++;
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
    this.focusStackScratch = new Float64Array(0);
    this.focusStackCheckpoints = new Float64Array(0);
    this.focusStackCheckpointSeries = new Int32Array(0);
    this.focusStackCheckpointGroupOffsets = new Int32Array(0);
    this.focusStackCheckpointGroupCounts = new Int32Array(0);
    this.focusStackCheckpointGroupStrides = new Int32Array(0);
    this.focusStackCheckpointGroupProgress = new Int32Array(0);
    this.invalidateFocusFrame();
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
    this.focusStackScratch = new Float64Array(0);
    this.focusStackCheckpoints = new Float64Array(0);
    this.focusStackCheckpointSeries = new Int32Array(0);
    this.focusStackCheckpointGroupOffsets = new Int32Array(0);
    this.focusStackCheckpointGroupCounts = new Int32Array(0);
    this.focusStackCheckpointGroupStrides = new Int32Array(0);
    this.focusStackCheckpointGroupProgress = new Int32Array(0);
    this.invalidateFocusFrame();
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
    if (controllers.get(this.source) === this) {
      controllers.delete(this.source);
    }
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

    if (this.shouldDrawProgressively(scanFrom, scanTo)) {
      this.plot = null;
      this.context = null;
      return this.drawProgressively(plot, scanFrom, scanTo, from, to).then((completed) => {
        if (completed) {
          this.focusFrameReady = true;
          this.drawFocusOverlay();
        }
        this.barLabelBounds.clear();
        return completed;
      });
    }

    this.prepareStackScratch(scanFrom, scanTo);
    this.prepareFocusStackCheckpoints();
    this.prepareGroupedBarAutoValueFontSize(scanFrom, scanTo);
    this.drawSeriesRange(plot, 0, this.source.seriesCount, scanFrom, scanTo, from, to, plot.ctx, true);
    this.focusFrameReady = true;
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
    context: CanvasRenderingContext2D = plot.ctx,
    captureStackCheckpoints = false
  ): void {
    this.plot = plot;
    this.context = context;
    context.save();
    try {
      context.beginPath();
      context.rect(plot.bbox.left, plot.bbox.top, plot.bbox.width, plot.bbox.height);
      context.clip();

      for (let series = seriesFrom; series < seriesTo; series++) {
        if (this.isVisible(series)) {
          this.drawSeries(series, scanFrom, scanTo, visibleFrom, visibleTo);
        }
        if (captureStackCheckpoints) {
          this.captureFocusStackCheckpoint(series);
        }
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
    let visibleSeriesCount = 0;
    for (let series = 0; series < this.source.seriesCount; series++) {
      if (!this.isVisible(series)) {
        continue;
      }
      visibleSeriesCount++;
      const style = this.getStyle(series);
      const autoPointsVisible =
        (this.source.columns.flags[series] & CompactSeriesFlag.AutoPoints) !== 0 &&
        this.shouldShowAutoPoints(this.plot!, style, from, to);
      if (!canDrawCompactSeriesProgressively(this.source, series, autoPointsVisible)) {
        return false;
      }
    }
    const pointCount = to - from + 1;
    return visibleSeriesCount * pointCount >= progressiveSampleThreshold(pointCount);
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
    const prepareStack = this.createProgressiveStackPreparation(scanFrom, scanTo);
    const prepareBarWidths = this.createProgressiveBarWidthPreparation();
    const prepareBarValueLabels = this.createProgressiveGroupedBarValuePreparation(plot, scanFrom, scanTo);
    let preparationStage = 0;
    let nextSeries = 0;

    return new Promise<boolean>((resolve) => {
      this.resolveProgressiveDraw = resolve;
      const drawChunk = () => {
        try {
          if (generation !== this.progressiveGeneration) {
            return false;
          }
          if (preparationStage === 0) {
            if (prepareStack()) {
              preparationStage = 1;
            }
            return true;
          }
          if (preparationStage === 1) {
            if (prepareBarWidths()) {
              preparationStage = 2;
            }
            return true;
          }
          if (preparationStage === 2) {
            if (prepareBarValueLabels()) {
              this.prepareFocusStackCheckpoints();
              preparationStage = 3;
            }
            return true;
          }
          const firstSeries = nextSeries;
          nextSeries = Math.min(this.source.seriesCount, firstSeries + seriesPerChunk);
          this.drawSeriesRange(plot, firstSeries, nextSeries, scanFrom, scanTo, visibleFrom, visibleTo, plot.ctx, true);

          if (nextSeries < this.source.seriesCount) {
            return true;
          }
          this.progressiveTask = undefined;
          this.resolveProgressiveDraw = undefined;
          resolve(true);
          return false;
        } catch (error) {
          this.progressiveTask = undefined;
          this.resolveProgressiveDraw = undefined;
          this.invalidateFocusFrame();
          resolve(false);
          throw error;
        }
      };
      this.progressiveTask = drawChunk;
      scheduleProgressiveDraw(drawChunk);
    });
  }

  private cancelProgressiveDraw(): void {
    this.progressiveGeneration++;
    if (this.progressiveTask) {
      cancelScheduledProgressiveDraw(this.progressiveTask);
      this.progressiveTask = undefined;
    }
    this.resolveProgressiveDraw?.(false);
    this.resolveProgressiveDraw = undefined;
    this.invalidateFocusFrame();
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
        this.invalidateFocusFrame();
        this.removeFocusOverlay();
        this.initializeBarSlots();
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
    this.cursorTargetDistance = Number.POSITIVE_INFINITY;
    this.cursorBarBodyPresent = false;
    this.cursorBarSeriesIndex = -1;
    this.cursorBarDataIndex = -1;
    this.cursorAreaVertexCache.clear();
    this.cursorStackPresenceCache.clear();

    if (index == null || index < 0 || index >= this.source.pointCount) {
      return null;
    }

    const focusStartedAt = hoverStageProbe ? performance.now() : 0;
    if (this.source.stackGroupCount > 0) {
      this.cursorStackIndexes.fill(-1);
    }
    if (this.visibleBarSlotCount > 0) {
      this.selectCursorBarsFromSource(plot, index, mouseY);
      if (this.cursorBarBodyPresent && !state.centered) {
        this.cursorBarSeriesIndex = state.seriesIndex;
        this.cursorBarDataIndex = state.dataIndex;
      }
      if (this.source.stackGroupCount > 0) {
        this.cursorStackIndexes.fill(-1);
      }
    }
    const needsSnapshot = origin !== 'native-sync' && this.source.cursorMode === 'multi';
    if (needsSnapshot) {
      this.ensureCursorSnapshotScratch();
      if (!this.isCursorSnapshotCurrent(index, plot)) {
        this.populateCursorSnapshot(index, plot);
      }
      this.selectCursorPointFromSnapshot(plot, index, mouseY);
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
      const flags = this.source.columns.flags[seriesIndex];
      if ((flags & CompactSeriesFlag.Bars) !== 0) {
        if ((flags & (CompactSeriesFlag.Points | CompactSeriesFlag.AutoPoints)) !== 0) {
          this.considerCursorBarCandidates(plot, seriesIndex, index, mouseY, false);
        }
        continue;
      }
      let dataIndex = index;
      let value = this.source.yAt(seriesIndex, dataIndex);
      if (value == null) {
        const nearest = this.nearestCursorDataIndex(plot, seriesIndex, index);
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
      const flags = this.source.columns.flags[seriesIndex];
      if ((flags & CompactSeriesFlag.Bars) !== 0) {
        if ((flags & (CompactSeriesFlag.Points | CompactSeriesFlag.AutoPoints)) !== 0) {
          this.considerCursorBarCandidates(plot, seriesIndex, index, mouseY, false);
        }
        continue;
      }
      let dataIndex = this.readCursorSnapshotDataIndex(seriesIndex);
      let value =
        dataIndex === index ? this.readCursorSnapshotValue(seriesIndex) : this.source.yAt(seriesIndex, dataIndex);
      if (value == null) {
        const focusIndex = this.nearestCursorDataIndex(plot, seriesIndex, index);
        if (focusIndex != null) {
          dataIndex = focusIndex;
          value = this.source.yAt(seriesIndex, focusIndex);
        }
      }
      this.considerCursorPoint(plot, seriesIndex, index, dataIndex, value, mouseY);
    }
  }

  private selectCursorBarsFromSource(plot: uPlot, index: number, mouseY: number): void {
    for (let seriesIndex = 0; seriesIndex < this.source.seriesCount; seriesIndex++) {
      if (this.isVisible(seriesIndex) && (this.source.columns.flags[seriesIndex] & CompactSeriesFlag.Bars) !== 0) {
        this.considerCursorBarCandidates(plot, seriesIndex, index, mouseY);
      }
    }
  }

  private considerCursorBarCandidates(
    plot: uPlot,
    seriesIndex: number,
    cursorIndex: number,
    mouseY: number,
    includeBarBody = true
  ): void {
    const source = this.source;
    const currentValue = source.yAt(seriesIndex, cursorIndex);
    if (currentValue != null) {
      this.considerCursorPoint(plot, seriesIndex, cursorIndex, cursorIndex, currentValue, mouseY, includeBarBody);
    }

    const leftStart = currentValue == null ? cursorIndex : cursorIndex - 1;
    const left = leftStart >= 0 ? source.nearestPresent(seriesIndex, leftStart, -1) : null;
    if (left != null && left !== cursorIndex) {
      this.considerCursorPoint(
        plot,
        seriesIndex,
        cursorIndex,
        left,
        source.yAt(seriesIndex, left),
        mouseY,
        includeBarBody
      );
    }

    const rightStart = currentValue == null ? cursorIndex : cursorIndex + 1;
    const right = rightStart < source.pointCount ? source.nearestPresent(seriesIndex, rightStart, 1) : null;
    if (right != null && right !== cursorIndex && right !== left) {
      this.considerCursorPoint(
        plot,
        seriesIndex,
        cursorIndex,
        right,
        source.yAt(seriesIndex, right),
        mouseY,
        includeBarBody
      );
    }
  }

  private considerCursorPoint(
    plot: uPlot,
    seriesIndex: number,
    cursorIndex: number,
    dataIndex: number,
    rawValue: CompactPlotValue,
    mouseY: number,
    includeBarBody = true
  ): void {
    if (rawValue == null) {
      return;
    }

    const flags = this.source.columns.flags[seriesIndex];
    const style = this.getStyle(seriesIndex);
    const hasBarFlag = (flags & CompactSeriesFlag.Bars) !== 0;
    const bar = includeBarBody && hasBarFlag && this.hasVisibleBarBody(style);
    const areaFill = !hasBarFlag && this.hasAreaFill(flags, style);
    const lineStroke =
      !hasBarFlag && (flags & CompactSeriesFlag.DrawLine) !== 0 && (style.lineWidth ?? 1) > 0 && (style.alpha ?? 1) > 0;
    const linePathHit = lineStroke && this.cursorBarBodyPresent;
    const visiblePointMarkers =
      (this.cursorBarBodyPresent || hasBarFlag) &&
      this.hasVisiblePointMarkers(plot, flags, style, this.focusVisibleFrom, this.focusVisibleTo);
    if (hasBarFlag && !bar && !visiblePointMarkers) {
      return;
    }
    const withinGroupProximity = this.isWithinCursorProximity(plot, seriesIndex, cursorIndex, dataIndex);
    if (!bar && !areaFill && !linePathHit && !withinGroupProximity) {
      return;
    }
    this.currentCursorStackBase = 0;
    const value = this.stackCursorValue(seriesIndex, dataIndex, rawValue);
    const stackBase = this.currentCursorStackBase;
    const scaleKey = this.getScaleKey(seriesIndex);
    const top = plot.valToPos(value, scaleKey);
    let barRect = bar ? this.getCursorBarRect(plot, seriesIndex, dataIndex, value, scaleKey, style) : null;
    if (barRect && !rectContains(barRect, this.requireCursorGroupPosition(plot), mouseY, plot.scales.x.ori === 1)) {
      barRect = null;
    }
    this.cursorBarBodyPresent ||= barRect != null;
    if (bar && this.source.barOptions?.mode === 'grouped' && !barRect) {
      return;
    }
    const pathBand =
      areaFill || linePathHit
        ? this.getCursorAreaBand(
            plot,
            seriesIndex,
            cursorIndex,
            { index: dataIndex, value, base: stackBase },
            flags,
            style,
            scaleKey
          )
        : null;
    const areaBand = areaFill ? pathBand : null;
    if (!barRect && !withinGroupProximity && !pathBand) {
      return;
    }
    const focus = plot.focus;
    const pathTop = pathBand?.top ?? top;
    const lineDistance = Math.abs(focus.dist?.(plot, seriesIndex + 1, dataIndex, pathTop, mouseY) ?? pathTop - mouseY);
    const bias = focus.bias ?? 0;
    if (bias !== 0) {
      const mouseValue = plot.posToVal(mouseY, scaleKey);
      const focusValue = pathBand ? plot.posToVal(pathBand.top, scaleKey) : value;
      const valueSign = focusValue >= 0 ? 1 : -1;
      const mouseSign = mouseValue >= 0 ? 1 : -1;
      const matchesBias =
        valueSign === mouseSign &&
        (mouseSign === 1
          ? bias === 1
            ? focusValue >= mouseValue
            : focusValue <= mouseValue
          : bias === 1
            ? focusValue <= mouseValue
            : focusValue >= mouseValue);
      if (!matchesBias) {
        return;
      }
    }
    const areaFillTarget =
      barRect == null &&
      areaBand != null &&
      mouseY >= Math.min(areaBand.top, areaBand.base) &&
      mouseY <= Math.max(areaBand.top, areaBand.base);
    const preciseLineTarget =
      barRect == null &&
      linePathHit &&
      (pathBand != null || withinGroupProximity) &&
      lineDistance <= Math.max(0, style.lineWidth ?? 1) / 2;
    const pointRadius = Math.max(0, style.pointSize ?? 3 + Math.max(1, style.lineWidth ?? 1) * 2) / 2;
    const pointGeometryDistance = visiblePointMarkers
      ? Math.hypot(this.requireCursorGroupPosition(plot) - plot.valToPos(this.source.xAt(dataIndex), 'x'), top - mouseY)
      : Number.POSITIVE_INFINITY;
    const precisePointTarget = barRect == null && visiblePointMarkers && pointGeometryDistance <= pointRadius;
    const targetDistance = barRect
      ? 0
      : preciseLineTarget && precisePointTarget
        ? Math.min(lineDistance, pointGeometryDistance)
        : precisePointTarget
          ? pointGeometryDistance
          : lineDistance;
    const targetPriority =
      preciseLineTarget || precisePointTarget
        ? CursorTargetPriority.PreciseGeometry
        : barRect
          ? CursorTargetPriority.BarBody
          : (withinGroupProximity || pathBand != null) && lineDistance <= focus.prox
            ? CursorTargetPriority.NearbyGeometry
            : areaFillTarget
              ? CursorTargetPriority.AreaFill
              : CursorTargetPriority.DistantGeometry;
    const betterTarget =
      targetPriority < this.cursorTargetPriority ||
      (targetPriority === this.cursorTargetPriority &&
        (targetDistance < this.cursorTargetDistance ||
          (targetDistance === this.cursorTargetDistance &&
            (targetPriority === CursorTargetPriority.BarBody
              ? seriesIndex > this.cursorState.seriesIndex
              : this.cursorState.seriesIndex < 0 || seriesIndex < this.cursorState.seriesIndex))));
    if (!betterTarget) {
      return;
    }

    this.cursorTargetPriority = targetPriority;
    this.cursorTargetDistance = targetDistance;
    this.cursorState.seriesIndex = seriesIndex;
    this.cursorState.dataIndex = dataIndex;
    this.cursorState.distance =
      barRect != null ||
      targetPriority === CursorTargetPriority.PreciseGeometry ||
      targetPriority === CursorTargetPriority.AreaFill
        ? 0
        : targetDistance;
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

  private hasAreaFill(flags: number, style: CompactStyleRecord): boolean {
    return (
      (flags & CompactSeriesFlag.DrawLine) !== 0 &&
      (style.areaFill != null || style.areaGradient != null) &&
      (style.alpha ?? 1) > 0
    );
  }

  private hasVisibleBarBody(style: CompactStyleRecord): boolean {
    return (
      (style.alpha ?? 1) > 0 && ((style.lineWidth ?? 1) > 0 || style.areaFill != null || style.areaGradient != null)
    );
  }

  private getCursorAreaBand(
    plot: uPlot,
    seriesIndex: number,
    cursorIndex: number,
    current: { index: number; value: number; base: number },
    flags: number,
    style: CompactStyleRecord,
    scaleKey: string
  ): { top: number; base: number } | null {
    const cursorGroupPosition = this.requireCursorGroupPosition(plot);
    const cursorGroupValue = plot.posToVal(cursorGroupPosition, 'x');
    const segment = this.findConnectedAreaSegment(seriesIndex, cursorIndex, cursorGroupValue, flags, style);
    if (!segment) {
      return null;
    }
    this.cursorAreaSamples.length = 0;
    const left = this.getCursorAreaSample(seriesIndex, segment[0], current, flags, plot, scaleKey);
    const right = this.getCursorAreaSample(seriesIndex, segment[1], current, flags, plot, scaleKey);
    if (!left || !right || left.groupPosition === right.groupPosition) {
      return null;
    }
    const fraction = Math.max(
      0,
      Math.min(1, (cursorGroupPosition - left.groupPosition) / (right.groupPosition - left.groupPosition))
    );
    const pathMode = flags & CompactSeriesFlag.PathMask;
    const topPosition =
      pathMode === CompactSeriesFlag.StepBefore
        ? right.top
        : pathMode === CompactSeriesFlag.StepAfter
          ? left.top
          : pathMode === CompactSeriesFlag.Spline
            ? this.getSplineCursorPosition(
                plot,
                seriesIndex,
                cursorGroupPosition,
                left,
                right,
                current,
                flags,
                style,
                scaleKey
              )
            : interpolate(left.top, right.top, fraction);
    const baselinePosition =
      (flags & CompactSeriesFlag.Stack) === 0
        ? left.base
        : pathMode === CompactSeriesFlag.StepBefore
          ? right.base
          : pathMode === CompactSeriesFlag.StepAfter
            ? left.base
            : interpolate(left.base, right.base, fraction);
    return { top: topPosition, base: baselinePosition };
  }

  private findConnectedAreaSegment(
    seriesIndex: number,
    cursorIndex: number,
    cursorValue: number,
    flags: number,
    style: CompactStyleRecord
  ): readonly [number, number] | null {
    const pointCount = this.source.pointCount;
    const pivotTimestamp = this.source.xAt(cursorIndex);
    const leftStart = pivotTimestamp <= cursorValue ? cursorIndex : cursorIndex - 1;
    const rightStart = pivotTimestamp >= cursorValue ? cursorIndex : cursorIndex + 1;
    const left = leftStart >= 0 ? this.nearestAreaVertex(seriesIndex, leftStart, -1, flags) : null;
    const right = rightStart < pointCount ? this.nearestAreaVertex(seriesIndex, rightStart, 1, flags) : null;
    if (left == null || right == null) {
      return null;
    }
    if (left !== right) {
      return this.isAreaSegmentConnected(seriesIndex, left, right, style) ? [left, right] : null;
    }

    const next = right + 1 < pointCount ? this.nearestAreaVertex(seriesIndex, right + 1, 1, flags) : null;
    if (next != null && this.isAreaSegmentConnected(seriesIndex, right, next, style)) {
      return [right, next];
    }
    const previous = left > 0 ? this.nearestAreaVertex(seriesIndex, left - 1, -1, flags) : null;
    return previous != null && this.isAreaSegmentConnected(seriesIndex, previous, left, style)
      ? [previous, left]
      : null;
  }

  private nearestAreaVertex(seriesIndex: number, index: number, bias: -1 | 1, flags: number): number | null {
    if ((flags & CompactSeriesFlag.Stack) === 0) {
      return this.source.nearestPresent(seriesIndex, index, bias);
    }
    const group = this.getStackGroup(seriesIndex);
    const cacheKey = (group * this.source.pointCount + index) * 2 + (bias > 0 ? 1 : 0);
    if (this.cursorAreaVertexCache.has(cacheKey)) {
      return this.cursorAreaVertexCache.get(cacheKey)!;
    }
    let nearest: number | null = null;
    for (let candidate = 0; candidate < this.source.seriesCount; candidate++) {
      if (!this.isVisible(candidate) || this.getStackGroup(candidate) !== group) {
        continue;
      }
      const present = this.source.nearestPresent(candidate, index, bias);
      if (present != null && (nearest == null || (bias < 0 ? present > nearest : present < nearest))) {
        nearest = present;
      }
    }
    this.cursorAreaVertexCache.set(cacheKey, nearest);
    return nearest;
  }

  private isAreaSegmentConnected(seriesIndex: number, from: number, to: number, style: CompactStyleRecord): boolean {
    if (this.shouldDisconnectBetween(style, this.source.xAt(from), this.source.xAt(to))) {
      return false;
    }
    if (this.source.isDirectSegmentConnected) {
      return this.source.isDirectSegmentConnected(seriesIndex, from, to);
    }
    for (let index = from + 1; index < to; index++) {
      if (this.source.yAt(seriesIndex, index) === null) {
        return false;
      }
    }
    return true;
  }

  private hasStackValueAt(seriesIndex: number, index: number): boolean {
    const group = this.getStackGroup(seriesIndex);
    const cacheKey = group * this.source.pointCount + index;
    const cached = this.cursorStackPresenceCache.get(cacheKey);
    if (cached != null) {
      return cached;
    }
    for (let candidate = 0; candidate < this.source.seriesCount; candidate++) {
      if (
        this.isVisible(candidate) &&
        this.getStackGroup(candidate) === group &&
        this.source.yAt(candidate, index) != null
      ) {
        this.cursorStackPresenceCache.set(cacheKey, true);
        return true;
      }
    }
    this.cursorStackPresenceCache.set(cacheKey, false);
    return false;
  }

  private getCursorAreaSample(
    seriesIndex: number,
    index: number,
    current: { index: number; value: number; base: number },
    flags: number,
    plot: uPlot,
    scaleKey: string
  ): CompactAreaSample | null {
    const cached = this.cursorAreaSamples.find((sample) => sample.index === index);
    if (cached) {
      return cached;
    }
    let value: number;
    let base: number;
    if (index === current.index) {
      value = current.value;
      base = current.base;
    } else {
      const rawValue = this.source.yAt(seriesIndex, index);
      if (
        typeof rawValue !== 'number' &&
        ((flags & CompactSeriesFlag.Stack) === 0 || !this.hasStackValueAt(seriesIndex, index))
      ) {
        return null;
      }
      value = this.stackCursorValue(seriesIndex, index, typeof rawValue === 'number' ? rawValue : 0);
      base = this.currentCursorStackBase;
    }
    const sample = {
      index,
      groupPosition: plot.valToPos(this.source.xAt(index), 'x'),
      top: plot.valToPos(value, scaleKey),
      base: plot.valToPos(
        (flags & CompactSeriesFlag.Stack) !== 0 ? base : this.getFillBaselineValue(plot, scaleKey),
        scaleKey
      ),
    };
    this.cursorAreaSamples.push(sample);
    return sample;
  }

  private getSplineCursorPosition(
    plot: uPlot,
    seriesIndex: number,
    cursorPosition: number,
    left: CompactAreaSample,
    right: CompactAreaSample,
    current: { index: number; value: number; base: number },
    flags: number,
    style: CompactStyleRecord,
    scaleKey: string
  ): number {
    const midpoint = midpointSample(left, right);
    const fraction = (cursorPosition - left.groupPosition) / (right.groupPosition - left.groupPosition);
    if (fraction <= 0.5) {
      const previousIndex = left.index > 0 ? this.nearestAreaVertex(seriesIndex, left.index - 1, -1, flags) : null;
      const previous =
        previousIndex != null && this.isAreaSegmentConnected(seriesIndex, previousIndex, left.index, style)
          ? this.getCursorAreaSample(seriesIndex, previousIndex, current, flags, plot, scaleKey)
          : null;
      return quadraticValueAtPosition(previous ? midpointSample(previous, left) : left, left, midpoint, cursorPosition);
    }

    const nextIndex =
      right.index + 1 < this.source.pointCount ? this.nearestAreaVertex(seriesIndex, right.index + 1, 1, flags) : null;
    const next =
      nextIndex != null && this.isAreaSegmentConnected(seriesIndex, right.index, nextIndex, style)
        ? this.getCursorAreaSample(seriesIndex, nextIndex, current, flags, plot, scaleKey)
        : null;
    return next
      ? quadraticValueAtPosition(midpoint, right, midpointSample(right, next), cursorPosition)
      : interpolate(
          midpoint.top,
          right.top,
          (cursorPosition - midpoint.groupPosition) / (right.groupPosition - midpoint.groupPosition)
        );
  }

  private getCursorBarRect(
    plot: uPlot,
    seriesIndex: number,
    dataIndex: number,
    value: number,
    scaleKey: string,
    style: CompactStyleRecord
  ): CompactRect | null {
    const grouped = this.source.barOptions?.mode === 'grouped';
    const previousFlags = this.flags;
    const previousPlot = this.plot;
    const previousSeriesIndex = this.seriesIndex;
    const previousScaleKey = this.scaleKey;
    const previousSlot = this.barSlot;
    const previousSlotCount = this.barSlotCount;
    const previousBarColumnWidth = this.barColumnWidth;
    const previousBarWidth = this.barWidth;
    const previousBarShift = this.barShift;
    const previousBarStrokeWidth = this.barStrokeWidth;
    const previousBarPixelRound = this.barPixelRound;
    const previousBarBaselineRound = this.barBaselineRound;
    const flags = this.source.columns.flags[seriesIndex];
    this.plot = plot;
    this.seriesIndex = seriesIndex;
    this.scaleKey = scaleKey;
    this.flags = flags;
    try {
      if (grouped) {
        this.selectGroupedBarSlot(seriesIndex, flags);
      } else {
        this.prepareTimeSeriesBarGeometry(seriesIndex, style);
      }
      const geometry = this.getBarGeometry(
        plot,
        dataIndex,
        this.source.xAt(dataIndex),
        value,
        this.currentCursorStackBase,
        style
      );
      if (!geometry) {
        return null;
      }
      const pixelRatio = uPlot.pxRatio;
      const rect = {
        left: (geometry.left - plot.bbox.left) / pixelRatio,
        top: (geometry.top - plot.bbox.top) / pixelRatio,
        width: geometry.width / pixelRatio,
        height: geometry.height / pixelRatio,
      };
      const fullHighlight = grouped && this.source.barOptions?.fullHighlight && (flags & CompactSeriesFlag.Stack) === 0;
      if (!fullHighlight) {
        const strokeExpansion = geometry.strokeWidth / (2 * pixelRatio);
        if (strokeExpansion > 0) {
          const right = Math.min(plot.bbox.width / pixelRatio, rect.left + rect.width + strokeExpansion);
          const bottom = Math.min(plot.bbox.height / pixelRatio, rect.top + rect.height + strokeExpansion);
          rect.left = Math.max(0, rect.left - strokeExpansion);
          rect.top = Math.max(0, rect.top - strokeExpansion);
          rect.width = right - rect.left;
          rect.height = bottom - rect.top;
        }
        const minimumThickness = Math.max(uPlot.pxRatio, geometry.strokeWidth) / pixelRatio;
        if (rect.width === 0) {
          rect.left -= minimumThickness / 2;
          rect.width = minimumThickness;
        }
        if (rect.height === 0) {
          rect.top -= minimumThickness / 2;
          rect.height = minimumThickness;
        }
        return rect;
      }
      if (geometry.horizontalGroups) {
        return {
          left: (geometry.outerBandStart - plot.bbox.left) / pixelRatio,
          top: 0,
          width: geometry.outerBarSize / pixelRatio,
          height: plot.bbox.height / pixelRatio,
        };
      }
      return {
        left: 0,
        top: (geometry.outerBandStart - plot.bbox.top) / pixelRatio,
        width: plot.bbox.width / pixelRatio,
        height: geometry.outerBarSize / pixelRatio,
      };
    } finally {
      this.flags = previousFlags;
      this.plot = previousPlot;
      this.seriesIndex = previousSeriesIndex;
      this.scaleKey = previousScaleKey;
      this.barSlot = previousSlot;
      this.barSlotCount = previousSlotCount;
      this.barColumnWidth = previousBarColumnWidth;
      this.barWidth = previousBarWidth;
      this.barShift = previousBarShift;
      this.barStrokeWidth = previousBarStrokeWidth;
      this.barPixelRound = previousBarPixelRound;
      this.barBaselineRound = previousBarBaselineRound;
    }
  }

  private isCursorSnapshotCurrent(index: number, plot?: uPlot): boolean {
    const cursorPosition = plot ? this.getCursorGroupPosition(plot) : undefined;
    return (
      this.cursorSnapshotIndex === index &&
      this.cursorSnapshotBarBodyPresent === this.cursorBarBodyPresent &&
      this.cursorSnapshotBarSeriesIndex === this.cursorBarSeriesIndex &&
      this.cursorSnapshotBarDataIndex === this.cursorBarDataIndex &&
      (!this.cursorSnapshotPositionSensitive || cursorPosition == null || cursorPosition === this.cursorSnapshotMouseX)
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
    if (this.resolveProgressiveDraw || !this.focusFrameReady) {
      this.removeFocusOverlay();
      return;
    }
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

    const renderStackScratch = this.stackScratch;
    const focusedSeries = this.focusedSeries;
    const focusedStacked = (this.source.columns.flags[focusedSeries] & CompactSeriesFlag.Stack) !== 0;
    const focusedStackGroup = focusedStacked ? this.getStackGroup(focusedSeries) : 0;
    try {
      if (focusedStacked) {
        this.stackScratch = this.focusStackScratch;
        if (!this.prepareFocusStack(focusedSeries, focusedStackGroup)) {
          this.removeFocusOverlay();
          return;
        }
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
      if (focusedStacked) {
        this.focusStackGroup = focusedStackGroup;
        this.focusStackSeries = focusedSeries;
      }
    } catch (error) {
      this.invalidateFocusStack();
      throw error;
    } finally {
      this.stackScratch = renderStackScratch;
      this.operation = ScanOperation.None;
    }
  }

  private prepareFocusStack(focusedSeries: number, focusedGroup: number): boolean {
    const required = this.stackPointCount * this.source.stackGroupCount;
    if (this.focusStackScratch.length < required) {
      this.focusStackScratch = new Float64Array(required);
      this.stackScratch = this.focusStackScratch;
      this.invalidateFocusStack();
    }

    type Baseline = {
      cost: number;
      source: 'current' | 'empty' | 'checkpoint' | 'suffix';
      checkpoint?: number;
      from: number;
      to: number;
    };
    const baselines: Baseline[] = [];
    const canUseCurrent = this.focusStackGroup === focusedGroup && this.focusStackSeries >= 0;
    if (canUseCurrent && this.focusStackSeries < focusedSeries) {
      baselines.push(
        this.createFocusStackBaseline('current', this.focusStackSeries + 1, focusedSeries - 1, focusedGroup)
      );
    }

    const checkpointOffset = (this.focusStackCheckpointGroupOffsets[focusedGroup] ?? 0) - 1;
    const checkpointCount = this.focusStackCheckpointGroupCounts[focusedGroup] ?? 0;
    let lowerCheckpoint = -1;
    for (let checkpoint = checkpointOffset; checkpoint < checkpointOffset + checkpointCount; checkpoint++) {
      const checkpointSeries = this.focusStackCheckpointSeries[checkpoint];
      if (checkpointSeries >= focusedSeries) {
        break;
      }
      lowerCheckpoint = checkpoint;
    }
    if (lowerCheckpoint >= 0) {
      const checkpointSeries = this.focusStackCheckpointSeries[lowerCheckpoint];
      baselines.push({
        ...this.createFocusStackBaseline('checkpoint', checkpointSeries + 1, focusedSeries - 1, focusedGroup),
        checkpoint: lowerCheckpoint,
      });
    }

    if (checkpointCount === 0) {
      baselines.push(this.createFocusStackBaseline('empty', 0, focusedSeries - 1, focusedGroup));
      baselines.push(this.createFocusStackBaseline('suffix', focusedSeries, this.source.seriesCount - 1, focusedGroup));
    }

    if (baselines.length === 0) {
      baselines.push(this.createFocusStackBaseline('empty', 0, focusedSeries - 1, focusedGroup));
    }
    let baseline = baselines.reduce((best, candidate) => (candidate.cost < best.cost ? candidate : best));
    const groupOffset = (focusedGroup - 1) * this.stackPointCount;
    if (baseline.source === 'suffix') {
      if (this.prepareFocusStackFromSuffix(baseline.from, baseline.to, focusedGroup)) {
        return true;
      }
      this.invalidateFocusStack();
      const fallback = baselines
        .filter((candidate) => candidate.source !== 'suffix' && candidate.source !== 'current')
        .reduce<
          Baseline | undefined
        >((best, candidate) => (best == null || candidate.cost < best.cost ? candidate : best), undefined);
      if (fallback == null || fallback.cost * this.stackPointCount > MAX_SYNC_FOCUS_STACK_SAMPLES) {
        return false;
      }
      baseline = fallback;
    }
    if (baseline.source === 'empty') {
      this.focusStackScratch.fill(0, groupOffset, groupOffset + this.stackPointCount);
    } else if (baseline.source === 'checkpoint') {
      const checkpointValueOffset = baseline.checkpoint! * this.stackPointCount;
      this.focusStackScratch.set(
        this.focusStackCheckpoints.subarray(checkpointValueOffset, checkpointValueOffset + this.stackPointCount),
        groupOffset
      );
    }
    this.adjustFocusStack(baseline.from, baseline.to, focusedGroup);
    return true;
  }

  private createFocusStackBaseline(
    source: 'current' | 'empty' | 'checkpoint' | 'suffix',
    from: number,
    to: number,
    group: number
  ) {
    let cost = 0;
    for (let series = from; series <= to; series++) {
      if (this.isVisibleStackSeries(series, group)) {
        cost++;
      }
    }
    return { cost, source, from, to };
  }

  private prepareFocusStackFromSuffix(from: number, to: number, group: number): boolean {
    const groupOffset = (group - 1) * this.stackPointCount;
    this.focusStackScratch.set(this.stackTotals.subarray(groupOffset, groupOffset + this.stackPointCount), groupOffset);
    this.focusStackSuffixStable = true;
    this.operation = ScanOperation.StackSubtract;
    try {
      for (let series = to; series >= from; series--) {
        if (!this.isVisibleStackSeries(series, group)) {
          continue;
        }
        this.seriesIndex = series;
        this.flags = this.source.columns.flags[series];
        this.source.scan(series, this.focusScanFrom, this.focusScanTo, this.visitPoint);
      }
    } finally {
      this.operation = ScanOperation.None;
    }
    return this.focusStackSuffixStable;
  }

  private adjustFocusStack(from: number, to: number, group: number): void {
    if (from > to) {
      return;
    }
    this.operation = ScanOperation.StackCommit;
    try {
      for (let series = from; series <= to; series++) {
        if (!this.isVisibleStackSeries(series, group)) {
          continue;
        }
        this.seriesIndex = series;
        this.flags = this.source.columns.flags[series];
        this.source.scan(series, this.focusScanFrom, this.focusScanTo, this.visitPoint);
      }
    } finally {
      this.operation = ScanOperation.None;
    }
  }

  private isVisibleStackSeries(series: number, group: number): boolean {
    return (
      this.isVisible(series) &&
      (this.source.columns.flags[series] & CompactSeriesFlag.Stack) !== 0 &&
      this.getStackGroup(series) === group
    );
  }

  private invalidateFocusStack(): void {
    this.focusStackGroup = 0;
    this.focusStackSeries = -1;
  }

  private invalidateFocusFrame(): void {
    this.focusFrameReady = false;
    this.focusStackCheckpointGroupOffsets.fill(0);
    this.focusStackCheckpointGroupCounts.fill(0);
    this.invalidateFocusStack();
  }

  private prepareFocusStackCheckpoints(): void {
    const metadataLength = this.source.stackGroupCount + 1;
    if (this.focusStackCheckpointGroupOffsets.length < metadataLength) {
      this.focusStackCheckpointGroupOffsets = new Int32Array(metadataLength);
      this.focusStackCheckpointGroupCounts = new Int32Array(metadataLength);
      this.focusStackCheckpointGroupStrides = new Int32Array(metadataLength);
      this.focusStackCheckpointGroupProgress = new Int32Array(metadataLength);
    } else {
      this.focusStackCheckpointGroupOffsets.fill(0, 0, metadataLength);
      this.focusStackCheckpointGroupCounts.fill(0, 0, metadataLength);
      this.focusStackCheckpointGroupStrides.fill(0, 0, metadataLength);
      this.focusStackCheckpointGroupProgress.fill(0, 0, metadataLength);
    }
    if (
      this.source.focusOverlayColor == null ||
      this.visibleSeriesCount < 2 ||
      this.stackPointCount === 0 ||
      this.source.stackGroupCount === 0
    ) {
      return;
    }

    const groupCounts = new Uint32Array(this.source.stackGroupCount + 1);
    for (let series = 0; series < this.source.seriesCount; series++) {
      if (this.isVisible(series) && (this.source.columns.flags[series] & CompactSeriesFlag.Stack) !== 0) {
        groupCounts[this.getStackGroup(series)]++;
      }
    }
    const targetBudget = Math.floor(TARGET_STACK_FOCUS_CHECKPOINT_VALUES / this.stackPointCount);
    const checkpointBudget = Math.min(
      MAX_STACK_FOCUS_CHECKPOINTS,
      targetBudget > 0 ? targetBudget : Number(this.stackPointCount <= MAX_STACK_FOCUS_CHECKPOINT_VALUES)
    );
    if (checkpointBudget === 0) {
      return;
    }

    const allocations = new Int32Array(metadataLength);
    for (let checkpoint = 0; checkpoint < checkpointBudget; checkpoint++) {
      let selectedGroup = 0;
      let selectedSpan = 1;
      for (let group = 1; group < metadataLength; group++) {
        const count = groupCounts[group];
        if (allocations[group] >= count - 1) {
          continue;
        }
        const span = Math.ceil(count / (allocations[group] + 1));
        if (span > selectedSpan) {
          selectedSpan = span;
          selectedGroup = group;
        }
      }
      if (selectedGroup === 0) {
        break;
      }
      allocations[selectedGroup]++;
    }

    let checkpointCount = 0;
    for (let group = 1; group < metadataLength; group++) {
      const allocation = allocations[group];
      if (allocation === 0) {
        continue;
      }
      const stride = Math.ceil(groupCounts[group] / (allocation + 1));
      const count = Math.min(allocation, Math.floor((groupCounts[group] - 1) / stride));
      this.focusStackCheckpointGroupOffsets[group] = checkpointCount + 1;
      this.focusStackCheckpointGroupCounts[group] = count;
      this.focusStackCheckpointGroupStrides[group] = stride;
      checkpointCount += count;
    }

    const required = checkpointCount * this.stackPointCount;
    if (this.focusStackCheckpoints.length < required) {
      this.focusStackCheckpoints = new Float64Array(required);
    }
    if (this.focusStackCheckpointSeries.length < checkpointCount) {
      this.focusStackCheckpointSeries = new Int32Array(checkpointCount);
    }
  }

  private captureFocusStackCheckpoint(series: number): void {
    if (!this.isVisibleStackSeries(series, this.getStackGroup(series))) {
      return;
    }
    const group = this.getStackGroup(series);
    const stride = this.focusStackCheckpointGroupStrides[group] ?? 0;
    if (stride === 0) {
      return;
    }
    const progress = ++this.focusStackCheckpointGroupProgress[group];
    if (progress % stride !== 0) {
      return;
    }
    const groupCheckpoint = progress / stride - 1;
    if (groupCheckpoint >= this.focusStackCheckpointGroupCounts[group]) {
      return;
    }
    const checkpoint = this.focusStackCheckpointGroupOffsets[group] - 1 + groupCheckpoint;
    const sourceOffset = (group - 1) * this.stackPointCount;
    const checkpointOffset = checkpoint * this.stackPointCount;
    this.focusStackCheckpointSeries[checkpoint] = series;
    this.focusStackCheckpoints.set(
      this.stackScratch.subarray(sourceOffset, sourceOffset + this.stackPointCount),
      checkpointOffset
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
    const hasPoints = this.hasVisiblePointMarkers(this.plot!, flags, style, visibleFrom, visibleTo);
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
    if (!grouped) {
      ctx.lineWidth = this.barStrokeWidth;
    }
    const showValue = this.getBarShowValue(style);
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
    const prepare = this.createProgressiveGroupedBarValuePreparation(this.plot!, from, to);
    while (!prepare()) {
      // The synchronous path deliberately completes the same bounded preparation in one turn.
    }
  }

  private createProgressiveGroupedBarValuePreparation(plot: uPlot, from: number, to: number): () => boolean {
    const options = this.source.barOptions;
    this.groupedBarAutoValueFontSize = null;
    if (
      options?.mode !== 'grouped' ||
      options.valueSize != null ||
      options.showValue === 'never' ||
      !this.source.formatValueAt
    ) {
      return () => true;
    }

    this.groupedBarAutoValueFontSize = BAR_VALUE_MAX_FONT_SIZE * uPlot.pxRatio;
    let series = 0;
    let index = from;
    return () => {
      let remaining = PROGRESSIVE_POINT_BUDGET;
      const previousPlot = this.plot;
      const previousContext = this.context;
      this.plot = plot;
      this.context = plot.ctx;
      plot.ctx.save();
      try {
        plot.ctx.font = `${14 * uPlot.pxRatio}px ${this.source.valueFontFamily ?? 'sans-serif'}`;
        while (series < this.source.seriesCount && remaining > 0) {
          const flags = this.source.columns.flags[series];
          const showValue = options.showValue ?? (this.getStyle(series).showValues ? 'always' : 'never');
          if (!this.isVisible(series) || (flags & CompactSeriesFlag.Bars) === 0 || showValue === 'never') {
            series++;
            index = from;
            continue;
          }

          const scanCost = (flags & CompactSeriesFlag.Stack) !== 0 ? 2 : 1;
          const pointBudget = Math.max(1, Math.floor(remaining / scanCost));
          const end = Math.min(to, index + pointBudget - 1);
          this.seriesIndex = series;
          this.flags = flags;
          this.scaleKey = this.getScaleKey(series);
          this.selectGroupedBarSlot(series, flags);
          this.operation = ScanOperation.BarValueSize;
          this.source.scan(series, index, end, this.visitPoint);
          if ((flags & CompactSeriesFlag.Stack) !== 0) {
            this.operation = ScanOperation.StackCommit;
            this.source.scan(series, index, end, this.visitPoint);
          }
          remaining -= (end - index + 1) * scanCost;
          if (end === to) {
            series++;
            index = from;
          } else {
            index = end + 1;
          }
        }
      } finally {
        plot.ctx.restore();
        this.operation = ScanOperation.None;
        this.plot = previousPlot;
        this.context = previousContext;
      }

      if (series < this.source.seriesCount) {
        return false;
      }

      this.stackScratch.fill(0, 0, this.stackPointCount * this.source.stackGroupCount);
      return true;
    };
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

  private createProgressiveBarWidthPreparation(): () => boolean {
    if (this.source.barOptions?.mode === 'grouped' || this.barWidthSamplesPrepared) {
      return () => true;
    }

    const seriesCount = this.source.seriesCount;
    const pointCount = this.source.pointCount;
    const visibleBars: number[] = [];
    const stackGroups: number[][] = Array.from({ length: this.source.stackGroupCount + 1 }, () => []);
    const cadences = new Set<number>();
    this.barWidthSamples = new Array<CompactBarWidthSample | null>(seriesCount).fill(null);
    this.firstVisibleStackSeries = new Int32Array(this.source.stackGroupCount + 1);
    this.firstVisibleStackSeries.fill(-1);
    this.lastVisibleStackSeries = new Int32Array(this.source.stackGroupCount + 1);
    this.lastVisibleStackSeries.fill(-1);

    for (let series = 0; series < seriesCount; series++) {
      const flags = this.source.columns.flags[series];
      if (!this.isVisible(series) || (flags & CompactSeriesFlag.Bars) === 0) {
        continue;
      }
      visibleBars.push(series);
      if ((flags & CompactSeriesFlag.Stack) !== 0) {
        const group = this.getStackGroup(series);
        stackGroups[group].push(series);
        if (this.firstVisibleStackSeries[group] < 0) {
          this.firstVisibleStackSeries[group] = series;
        }
        this.lastVisibleStackSeries[group] = series;
      }
    }

    let globalCadence = Number.POSITIVE_INFINITY;
    let globalSample: CompactBarWidthSample | null = null;
    let stage: 'series' | 'stacks' | 'finalize' = 'series';
    let visibleIndex = 0;
    let rawValues = true;
    let pointIndex = 0;
    let previousTimestamp: number | null = null;
    let minimumTimestampDelta = Number.POSITIVE_INFINITY;
    let sample: CompactBarWidthSample | null = null;
    let groupIndex = 1;
    let groupPoint = 0;
    let groupOffset = 0;
    let groupHasValue = false;
    let groupValues: CompactPlotValue[] = [];
    let groupPreviousTimestamps: Array<number | null> = [];
    let groupMinimumTimestampDeltas = new Float64Array(0);
    let groupSamples: Array<CompactBarWidthSample | null> = [];

    const resetSeriesScan = () => {
      pointIndex = 0;
      previousTimestamp = null;
      minimumTimestampDelta = Number.POSITIVE_INFINITY;
      sample = null;
    };

    const finishSeriesScan = (series: number) => {
      if (rawValues) {
        if (sample != null) {
          const cadence = normalizeBarCadence(sample.timestamp - sample.previousTimestamp);
          cadences.add(cadence);
          if (cadence < globalCadence) {
            globalCadence = cadence;
            globalSample = sample;
          }
        }
        if ((this.source.columns.flags[series] & CompactSeriesFlag.Stack) === 0) {
          rawValues = false;
          resetSeriesScan();
          return;
        }
      } else {
        this.barWidthSamples[series] = sample;
      }
      visibleIndex++;
      rawValues = true;
      resetSeriesScan();
    };

    const beginStackGroup = (seriesIndexes: number[]) => {
      groupPoint = 0;
      groupOffset = 0;
      groupHasValue = false;
      groupValues = new Array<CompactPlotValue>(seriesIndexes.length);
      groupPreviousTimestamps = new Array<number | null>(seriesIndexes.length).fill(null);
      groupMinimumTimestampDeltas = new Float64Array(seriesIndexes.length).fill(Number.POSITIVE_INFINITY);
      groupSamples = new Array<CompactBarWidthSample | null>(seriesIndexes.length).fill(null);
    };

    return () => {
      let remaining = PROGRESSIVE_POINT_BUDGET;
      while (remaining > 0) {
        if (stage === 'series') {
          if (visibleIndex >= visibleBars.length) {
            stage = 'stacks';
            continue;
          }
          const series = visibleBars[visibleIndex];
          if (pointIndex >= pointCount) {
            finishSeriesScan(series);
            continue;
          }
          const value =
            rawValues && this.source.barWidthValueAt
              ? this.source.barWidthValueAt(series, pointIndex)
              : this.source.cursorValueAt(series, pointIndex);
          if (value !== undefined) {
            const timestamp = this.source.xAt(pointIndex);
            if (previousTimestamp != null) {
              const delta = Math.abs(timestamp - previousTimestamp);
              if (delta < minimumTimestampDelta) {
                minimumTimestampDelta = delta;
                sample = { previousTimestamp, timestamp };
              }
            }
            previousTimestamp = timestamp;
          }
          pointIndex++;
          remaining--;
          continue;
        }

        if (stage === 'stacks') {
          while (groupIndex < stackGroups.length && stackGroups[groupIndex].length === 0) {
            groupIndex++;
          }
          if (groupIndex >= stackGroups.length) {
            stage = 'finalize';
            continue;
          }
          const seriesIndexes = stackGroups[groupIndex];
          if (groupValues.length === 0) {
            beginStackGroup(seriesIndexes);
          }
          if (groupPoint >= pointCount) {
            for (let offset = 0; offset < seriesIndexes.length; offset++) {
              this.barWidthSamples[seriesIndexes[offset]] = groupSamples[offset];
            }
            groupIndex++;
            groupValues = [];
            continue;
          }
          if (groupOffset < seriesIndexes.length) {
            const series = seriesIndexes[groupOffset];
            const value = this.source.cursorValueAt(series, groupPoint);
            groupValues[groupOffset] = value;
            const barWidthValue = this.source.barWidthValueAt ? this.source.barWidthValueAt(series, groupPoint) : value;
            groupHasValue ||= barWidthValue != null;
            groupOffset++;
            remaining--;
            continue;
          }

          const timestamp = this.source.xAt(groupPoint);
          for (let offset = 0; offset < seriesIndexes.length; offset++) {
            if (!groupHasValue && groupValues[offset] === undefined) {
              continue;
            }
            const previous = groupPreviousTimestamps[offset];
            if (previous != null) {
              const delta = Math.abs(timestamp - previous);
              if (delta < groupMinimumTimestampDeltas[offset]) {
                groupMinimumTimestampDeltas[offset] = delta;
                groupSamples[offset] = { previousTimestamp: previous, timestamp };
              }
            }
            groupPreviousTimestamps[offset] = timestamp;
          }
          groupPoint++;
          groupOffset = 0;
          groupHasValue = false;
          continue;
        }

        if (visibleBars.length > 1 && cadences.size > 1 && globalSample != null) {
          for (const series of visibleBars) {
            if ((this.source.columns.flags[series] & CompactSeriesFlag.Constant) !== 0) {
              continue;
            }
            const current = this.barWidthSamples[series];
            if (current == null || normalizeBarCadence(current.timestamp - current.previousTimestamp) > globalCadence) {
              this.barWidthSamples[series] = globalSample;
            }
          }
        }
        this.barWidthSamplesPrepared = true;
        return true;
      }
      return false;
    };
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

  private getBarGeometry(
    plot: uPlot,
    index: number,
    timestamp: number,
    value: number,
    base: number,
    style: CompactStyleRecord
  ): CompactBarGeometry | null {
    const grouped = this.source.barOptions?.mode === 'grouped';
    let valuePosition = plot.valToPos(value, this.scaleKey, true);
    let basePosition = plot.valToPos(base, this.scaleKey, true);
    let bandStart: number;
    let barSize: number;
    let groupedBandSize = 0;
    if (grouped) {
      const { center, size: bandSize } = this.getBarBandForPlot(plot, index, timestamp, true);
      groupedBandSize = bandSize;
      ({ start: bandStart, size: barSize } = this.getGroupedBarPlacement(center, bandSize));
    } else {
      valuePosition = this.barPixelRound(valuePosition);
      basePosition = this.barBaselineRound(basePosition);
      bandStart = this.barPixelRound(plot.valToPos(timestamp, 'x', true) - this.barShift);
      barSize = this.barWidth;
    }
    const outerBandStart = bandStart;
    const outerBarSize = barSize;
    const outerValueStart = Math.min(valuePosition, basePosition);
    const outerValueSize = Math.abs(valuePosition - basePosition);
    const valueAtStart = valuePosition <= basePosition;
    const configuredStrokeWidth = grouped
      ? Math.round(Math.max(0, style.lineWidth ?? 1) * uPlot.pxRatio)
      : this.barStrokeWidth;
    let strokeWidth = configuredStrokeWidth;
    if (grouped && strokeWidth >= barSize / 2) {
      strokeWidth = 0;
    }
    const groupedStrokeSuppressed = grouped && configuredStrokeWidth > 0 && strokeWidth === 0;
    if (grouped && strokeWidth > 0) {
      if (barSize < groupedBandSize) {
        bandStart += strokeWidth / 2;
        barSize = Math.max(0, barSize - strokeWidth);
      }
      const pathStart = outerValueStart + Math.floor(strokeWidth / 2);
      const pathEnd = pathStart + Math.max(0, outerValueSize - strokeWidth);
      valuePosition = valueAtStart ? pathStart : pathEnd;
      basePosition = valueAtStart ? pathEnd : pathStart;
    }
    const strokeInset = grouped ? 0 : Math.floor(strokeWidth / 2);
    const valueStart = grouped ? Math.min(valuePosition, basePosition) : outerValueStart + strokeInset;
    const valueSize = grouped ? Math.abs(valuePosition - basePosition) : Math.max(0, outerValueSize - strokeWidth);
    const xScale = plot.scales.x;
    const horizontalGroups = xScale?.ori !== 1;
    const left = horizontalGroups ? bandStart : valueStart;
    const top = horizontalGroups ? valueStart : bandStart;
    const width = horizontalGroups ? barSize : valueSize;
    const height = horizontalGroups ? valueSize : barSize;

    if ((grouped && (width < 0 || height < 0)) || (!grouped && (width <= 0 || height <= 0))) {
      return null;
    }

    return {
      left,
      top,
      width,
      height,
      outerBandStart,
      outerBarSize,
      outerValueStart,
      outerValueSize,
      valuePosition,
      basePosition,
      horizontalGroups,
      strokeWidth,
      groupedStrokeSuppressed,
    };
  }

  private visitBar(index: number, rawValue: CompactPlotValue, timestamp: number): void {
    if (rawValue == null) {
      return;
    }

    const style = this.getStyle(this.seriesIndex);
    const value = this.renderValue(index, rawValue, false);
    const grouped = this.source.barOptions?.mode === 'grouped';
    const geometry = this.getBarGeometry(this.plot!, index, timestamp, value, this.currentStackBase, style);
    if (!geometry) {
      return;
    }
    const {
      left: x,
      top: y,
      width,
      height,
      outerBandStart,
      outerBarSize,
      outerValueStart,
      outerValueSize,
      valuePosition,
      basePosition,
      horizontalGroups,
      strokeWidth,
      groupedStrokeSuppressed,
    } = geometry;
    this.groupedBarStrokeSuppressed = groupedStrokeSuppressed;

    const ctx = this.context!;
    if (grouped && strokeWidth > 0) {
      ctx.lineWidth = strokeWidth;
    }
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
      let labelValue = grouped ? rawValue : value;
      if (grouped && (this.flags & CompactSeriesFlag.PercentStack) !== 0) {
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
    const showValue = this.getBarShowValue(this.getStyle(this.seriesIndex));
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

  private getBarShowValue(style: CompactStyleRecord): 'auto' | 'always' | 'never' {
    if (this.source.barOptions?.showValue) {
      return this.source.barOptions.showValue;
    }
    if (!style.showValues || this.source.pointCount === 0 || !this.plot) {
      return 'never';
    }
    return this.plot.bbox.width / uPlot.pxRatio / this.source.pointCount >= 30 ? 'always' : 'never';
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
    if (!Number.isFinite(this.previousTimestamp)) {
      return false;
    }
    return this.shouldDisconnectBetween(style, this.previousTimestamp, timestamp);
  }

  private shouldDisconnectBetween(style: CompactStyleRecord, previousTimestamp: number, timestamp: number): boolean {
    const threshold = style.disconnectThreshold;
    if (threshold == null) {
      return false;
    }
    const delta = timestamp - previousTimestamp;
    if (delta <= threshold) {
      return false;
    }
    const spanThreshold = style.spanNullsThreshold;
    return spanThreshold == null || spanThreshold === -1 || delta >= spanThreshold;
  }

  private hasVisiblePointMarkers(
    plot: uPlot,
    flags: number,
    style: CompactStyleRecord,
    from: number,
    to: number
  ): boolean {
    return (
      (style.alpha ?? 1) > 0 &&
      ((flags & CompactSeriesFlag.Points) !== 0 ||
        ((flags & CompactSeriesFlag.AutoPoints) !== 0 && this.shouldShowAutoPoints(plot, style, from, to)))
    );
  }

  private shouldShowAutoPoints(plot: uPlot, style: CompactStyleRecord, from: number, to: number): boolean {
    const x0 = plot.valToPos(this.source.xAt(from), 'x', true);
    const x1 = plot.valToPos(this.source.xAt(to), 'x', true);
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
    const total = this.stackTotals[scratchIndex];
    const next = total + rawValue;
    const exact =
      this.stackPresence[scratchIndex] !== 2 &&
      Number.isSafeInteger(total) &&
      Number.isSafeInteger(rawValue) &&
      Number.isSafeInteger(next);
    this.stackPresence[scratchIndex] = exact ? 1 : 2;
    this.stackTotals[scratchIndex] = next;
  }

  private visitStackSubtract(index: number, rawValue: CompactPlotValue): void {
    if (rawValue == null || rawValue === 0) {
      return;
    }
    const scratchIndex = this.getStackScratchIndex(index);
    const total = this.focusStackScratch[scratchIndex];
    const baseline = total - rawValue;
    if (
      this.stackPresence[scratchIndex] !== 1 ||
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(rawValue) ||
      !Number.isSafeInteger(baseline)
    ) {
      this.focusStackSuffixStable = false;
      return;
    }
    this.focusStackScratch[scratchIndex] = baseline;
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
    const total = this.stackTotals[scratchIndex];
    const group = Math.floor(scratchIndex / this.stackPointCount);
    const direction = this.source.stackDirections?.[group] ?? 1;
    return total === 0 || value === 0 ? 0 : (direction * value) / total;
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
    const direction = this.source.stackDirections?.[group - 1] ?? 1;
    this.currentCursorStackBase = total === 0 || stackBase === 0 ? 0 : (direction * stackBase) / total;
    return total === 0 || stackedValue === 0 ? 0 : (direction * stackedValue) / total;
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
    this.resetStackScratch(from, to);
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

  private resetStackScratch(from: number, to: number): void {
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
    this.operation = ScanOperation.None;
  }

  private createProgressiveStackPreparation(from: number, to: number): () => boolean {
    this.resetStackScratch(from, to);
    let series = 0;
    let index = from;
    return () => {
      let remaining = PROGRESSIVE_POINT_BUDGET;
      this.operation = ScanOperation.StackTotal;
      while (series < this.source.seriesCount && remaining > 0) {
        const flags = this.source.columns.flags[series];
        if (!this.isVisible(series) || (flags & CompactSeriesFlag.Stack) === 0) {
          series++;
          index = from;
          continue;
        }
        const end = Math.min(to, index + remaining - 1);
        this.seriesIndex = series;
        this.flags = flags;
        this.source.scan(series, index, end, this.visitPoint);
        remaining -= end - index + 1;
        if (end === to) {
          series++;
          index = from;
        } else {
          index = end + 1;
        }
      }
      this.operation = ScanOperation.None;
      return series >= this.source.seriesCount;
    };
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

  private populateCursorSnapshot(index: number, plot?: uPlot): void {
    const source = this.source;
    const startedAt = hoverStageProbe ? performance.now() : 0;
    let valueReads = 0;
    let nearestReads = 0;
    const previousIndex = this.cursorSnapshotIndex;
    const existingDataIndexes = this.cursorSnapshotDataIndexes;
    let changed = previousIndex !== index;
    let positionSensitive = false;

    for (let seriesIndex = 0; seriesIndex < source.seriesCount; seriesIndex++) {
      const previousState = this.cursorSnapshotStates[seriesIndex];
      const previousValue = this.cursorSnapshotValues[seriesIndex];
      const previousDataIndex = existingDataIndexes?.[seriesIndex] ?? previousIndex;
      let dataIndex =
        seriesIndex === this.cursorBarSeriesIndex && this.cursorBarDataIndex >= 0 ? this.cursorBarDataIndex : index;
      const value = source.cursorValueAt(seriesIndex, dataIndex);
      valueReads++;
      if (value == null) {
        positionSensitive ||= plot != null && this.cursorProximityDependsOnPosition(plot);
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
    this.cursorSnapshotPositionSensitive = positionSensitive;
    this.cursorSnapshotBarBodyPresent = this.cursorBarBodyPresent;
    this.cursorSnapshotBarSeriesIndex = this.cursorBarSeriesIndex;
    this.cursorSnapshotBarDataIndex = this.cursorBarDataIndex;
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
    this.cursorSnapshotPositionSensitive = false;
    this.cursorSnapshotBarBodyPresent = false;
    this.cursorSnapshotBarSeriesIndex = -1;
    this.cursorSnapshotBarDataIndex = -1;
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

  private nearestCursorDataIndex(plot: uPlot, seriesIndex: number, index: number): number | null {
    const flags = this.source.columns.flags[seriesIndex];
    const style = this.getStyle(seriesIndex);
    const pathGeometry =
      this.hasAreaFill(flags, style) ||
      (this.cursorBarBodyPresent &&
        (flags & CompactSeriesFlag.DrawLine) !== 0 &&
        (style.lineWidth ?? 1) > 0 &&
        (style.alpha ?? 1) > 0);
    return pathGeometry
      ? this.source.nearestPresent(seriesIndex, index, 0)
      : this.nearestPresentAtCursor(plot, seriesIndex, index);
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

  private cursorProximityDependsOnPosition(plot: uPlot): boolean {
    const proximity = plot.cursor.hover?.prox;
    return (
      typeof proximity === 'function' || (typeof proximity === 'number' && proximity >= 0 && Number.isFinite(proximity))
    );
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

function midpointSample(left: CompactAreaPoint, right: CompactAreaPoint): CompactAreaPoint {
  return {
    groupPosition: (left.groupPosition + right.groupPosition) / 2,
    top: (left.top + right.top) / 2,
  };
}

function quadraticValueAtPosition(
  start: CompactAreaPoint,
  control: CompactAreaPoint,
  end: CompactAreaPoint,
  position: number
): number {
  const increasing = end.groupPosition >= start.groupPosition;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 20; iteration++) {
    const fraction = (lower + upper) / 2;
    const groupPosition = quadraticValue(start.groupPosition, control.groupPosition, end.groupPosition, fraction);
    if (groupPosition < position === increasing) {
      lower = fraction;
    } else {
      upper = fraction;
    }
  }
  return quadraticValue(start.top, control.top, end.top, (lower + upper) / 2);
}

function quadraticValue(start: number, control: number, end: number, fraction: number): number {
  const remaining = 1 - fraction;
  return remaining * remaining * start + 2 * remaining * fraction * control + fraction * fraction * end;
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
  if (source.stackDirections && source.stackDirections.length !== source.stackGroupCount) {
    throw new Error('Compact renderer stack directions must match stackGroupCount');
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
