import { CompactTimeSeriesAxis, CompactTimeSeriesData, CompactTimeSeriesSeries } from '@grafana/data';
import { GraphTransform } from '@grafana/schema';

import { CompactIndexColumnBuilder } from './compactColumns';

const RANK_CHECKPOINT_STRIDE = 256;
const MIN_RANK_CHECKPOINT_POINTS = RANK_CHECKPOINT_STRIDE * 64;
const MAX_ALIGNMENT_CHECKPOINT_ENTRIES = 1024 * 1024;
const TRANSFORM_NONE = 0;
const TRANSFORM_NEGATIVE_Y = 1;
const TRANSFORM_CONSTANT = 2;
const SPAN_NULLS_ALWAYS = Number.POSITIVE_INFINITY;

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, input) => {
  let value = input;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
});

export interface CompactPlotSeriesOptions {
  noValue?: string;
  transform?: GraphTransform;
  spanNulls?: boolean | number;
  insertNulls?: boolean | number;
}

type CompactPlotValue = number | null | undefined;
type CompactScaleMode = 'all' | 'positive';
type CompactPointVisitor = (index: number, value: CompactPlotValue, timestamp?: number) => void;

interface CompactBufferScan {
  axisStart: number;
  axisStep: number;
  valuesByteOffset: number;
  presenceByteOffset: number;
  presenceByteLength: number;
  packedIndex: number;
  valueMultiplier: 1 | -1;
  missingValue: CompactPlotValue;
}

export interface CompactPlotSource {
  readonly kind: 'compact-v1';
  readonly buffer: ArrayBuffer;
  readonly pointCount: number;
  readonly seriesCount: number;
  release(): void;
  xAt(index: number): number;
  closestXIndex(value: number, from: number, to: number): number;
  cursorValueAt(seriesIndex: number, index: number): CompactPlotValue;
  yAt(seriesIndex: number, index: number): CompactPlotValue;
  scan(seriesIndex: number, from: number, to: number, visitor: CompactPointVisitor): void;
  prepareBufferScan(seriesIndex: number, from: number, target: CompactBufferScan): boolean;
  extent(seriesIndex: number, from: number, to: number, mode: CompactScaleMode): [number | null, number | null];
  nearestPresent(seriesIndex: number, index: number, bias: -1 | 0 | 1): number | null;
}

export function createCompactPlotSource(
  data: CompactTimeSeriesData,
  getOptions: (seriesIndex: number) => CompactPlotSeriesOptions | undefined = () => undefined
): CompactPlotSource {
  return new BufferBackedCompactPlotSource(data, getOptions);
}

class BufferBackedCompactPlotSource implements CompactPlotSource {
  readonly kind = 'compact-v1' as const;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly alignment: CompactAxisAlignment;
  private readonly optionIds: Uint8Array | Uint16Array | Uint32Array;
  private readonly noValues: Float64Array;
  private readonly transforms: Uint8Array;
  private readonly spanNulls: Float64Array;
  private readonly insertNulls: Float64Array;
  private readonly rankCheckpoints = new Map<number, Uint32Array>();
  private readonly constantIndexes = new Map<number, number | null>();

  constructor(
    private readonly data: CompactTimeSeriesData,
    getOptions: (seriesIndex: number) => CompactPlotSeriesOptions | undefined
  ) {
    this.view = new DataView(data.buffer);
    this.bytes = new Uint8Array(data.buffer);
    this.alignment = new CompactAxisAlignment(data.axes, collectAxisIds(data));
    const optionIdsByValue = new Map<number, Map<number, Map<number, Map<number, number>>>>();
    const optionIds = new CompactIndexColumnBuilder(data.series.length);
    const noValues: number[] = [];
    const transforms: number[] = [];
    const spanNulls: number[] = [];
    const insertNulls: number[] = [];
    for (let seriesIndex = 0; seriesIndex < data.series.length; seriesIndex++) {
      const options = getOptions(seriesIndex);
      const noValue = Number(options?.noValue);
      const transform =
        options?.transform === GraphTransform.NegativeY
          ? TRANSFORM_NEGATIVE_Y
          : options?.transform === GraphTransform.Constant
            ? TRANSFORM_CONSTANT
            : TRANSFORM_NONE;
      const spanNull =
        options?.spanNulls === true
          ? SPAN_NULLS_ALWAYS
          : typeof options?.spanNulls === 'number'
            ? options.spanNulls
            : NaN;
      const normalizedNoValue = Number.isNaN(noValue) ? NaN : noValue;
      const insertNull =
        typeof options?.insertNulls === 'number' && options.insertNulls > 0 ? options.insertNulls : NaN;
      let optionId = findPlotOptionId(optionIdsByValue, normalizedNoValue, transform, spanNull, insertNull);
      if (optionId == null) {
        optionId = noValues.length;
        setPlotOptionId(optionIdsByValue, normalizedNoValue, transform, spanNull, insertNull, optionId);
        noValues.push(normalizedNoValue);
        transforms.push(transform);
        spanNulls.push(spanNull);
        insertNulls.push(insertNull);
      }
      optionIds.set(seriesIndex, optionId);
    }
    this.optionIds = optionIds.finish();
    this.noValues = Float64Array.from(noValues);
    this.transforms = Uint8Array.from(transforms);
    this.spanNulls = Float64Array.from(spanNulls);
    this.insertNulls = Float64Array.from(insertNulls);
  }

  get pointCount(): number {
    return this.alignment.pointCount;
  }

  get buffer(): ArrayBuffer {
    return this.data.buffer;
  }

  get seriesCount(): number {
    return this.data.series.length;
  }

  release(): void {
    // Query state owns the response buffer and may share this source across panels.
  }

  xAt(index: number): number {
    return this.alignment.xAt(index);
  }

  closestXIndex(value: number, from: number, to: number): number {
    this.assertInclusiveRange(from, to);
    if (from === to) {
      return from;
    }
    let low = from;
    let high = to;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.xAt(middle) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low === from) {
      return low;
    }
    const previous = low - 1;
    return value - this.xAt(previous) <= this.xAt(low) - value ? previous : low;
  }

  yAt(seriesIndex: number, index: number): CompactPlotValue {
    this.assertSeriesIndex(seriesIndex);
    this.assertPointIndex(index);
    const axis = this.getAxis(seriesIndex);
    const localIndex = this.alignment.localIndexAt(this.getAxisId(seriesIndex), index);
    const value = localIndex < 0 ? undefined : this.readConfiguredLocalValue(seriesIndex, localIndex);
    return this.applyRenderSemantics(seriesIndex, index, axis, value);
  }

  cursorValueAt(seriesIndex: number, index: number): CompactPlotValue {
    this.assertSeriesIndex(seriesIndex);
    this.assertPointIndex(index);
    const localIndex = this.alignment.localIndexAt(this.getAxisId(seriesIndex), index);
    if (localIndex < 0) {
      return undefined;
    }
    const value = this.readConfiguredLocalValue(seriesIndex, localIndex);
    if (this.getTransform(seriesIndex) !== TRANSFORM_CONSTANT) {
      return value;
    }
    return this.getConstantIndex(seriesIndex) === index ? value : undefined;
  }

  scan(seriesIndex: number, from: number, to: number, visitor: CompactPointVisitor): void {
    this.assertSeriesIndex(seriesIndex);
    this.assertInclusiveRange(from, to);

    if (this.alignment.isShared) {
      this.scanShared(seriesIndex, from, to, visitor);
      return;
    }

    const axis = this.getAxis(seriesIndex);
    this.alignment.scanAxis(this.getAxisId(seriesIndex), from, to + 1, (index, timestamp, localIndex) => {
      const value = localIndex < 0 ? undefined : this.readConfiguredLocalValue(seriesIndex, localIndex);
      visitor(index, this.applyRenderSemantics(seriesIndex, index, axis, value, timestamp), timestamp);
    });
  }

  prepareBufferScan(seriesIndex: number, from: number, target: CompactBufferScan): boolean {
    this.assertSeriesIndex(seriesIndex);
    this.assertPointIndex(from);
    if (!this.alignment.isShared) {
      return false;
    }

    const optionId = this.optionIds[seriesIndex];
    const transform = this.transforms[optionId];
    if (transform === TRANSFORM_CONSTANT) {
      return false;
    }

    const axis = this.getAxis(seriesIndex);
    const presenceByteLength = this.getPresenceByteLength(seriesIndex);
    const noValue = this.noValues[optionId];
    const spanNulls = this.spanNulls[optionId];
    const insertThreshold = this.getInsertThreshold(seriesIndex, axis);
    const needsGapClassification =
      presenceByteLength > 0 &&
      Number.isNaN(noValue) &&
      spanNulls !== SPAN_NULLS_ALWAYS &&
      (insertThreshold > axis.step || Number.isFinite(spanNulls));
    if (needsGapClassification) {
      return false;
    }

    const valueMultiplier = transform === TRANSFORM_NEGATIVE_Y ? -1 : 1;
    target.axisStart = axis.start;
    target.axisStep = axis.step;
    target.valuesByteOffset = this.getValuesByteOffset(seriesIndex);
    target.presenceByteOffset = this.getPresenceByteOffset(seriesIndex);
    target.presenceByteLength = presenceByteLength;
    target.packedIndex = presenceByteLength === 0 ? from : this.rankBefore(seriesIndex, from);
    target.valueMultiplier = valueMultiplier;
    target.missingValue = Number.isNaN(noValue)
      ? spanNulls === SPAN_NULLS_ALWAYS
        ? undefined
        : null
      : noValue * valueMultiplier;
    return true;
  }

  extent(
    seriesIndex: number,
    from: number,
    to: number,
    mode: CompactScaleMode = 'all'
  ): [number | null, number | null] {
    this.assertSeriesIndex(seriesIndex);
    this.assertInclusiveRange(from, to);

    if (this.getTransform(seriesIndex) === TRANSFORM_CONSTANT) {
      const constantIndex = this.getConstantIndex(seriesIndex);
      if (constantIndex == null || constantIndex < from || constantIndex > to) {
        return [null, null];
      }
      const value = this.yAt(seriesIndex, constantIndex);
      return value == null || (mode === 'positive' && value <= 0) ? [null, null] : [value, value];
    }

    const axis = this.getAxis(seriesIndex);
    const startTimestamp = this.xAt(from);
    const endTimestamp = this.xAt(to);
    const localFrom = Math.max(0, Math.ceil((startTimestamp - axis.start) / axis.step));
    const localTo = Math.min(axis.count, Math.floor((endTimestamp - axis.start) / axis.step) + 1);
    if (localFrom >= localTo) {
      return [null, null];
    }

    let min: number | null = null;
    let max: number | null = null;
    this.scanLocalValues(seriesIndex, localFrom, localTo, (value) => {
      const configured = this.applyValueOptions(value, seriesIndex);
      if (configured == null) {
        return;
      }
      if (mode === 'positive' && configured <= 0) {
        return;
      }
      min = min == null || configured < min ? configured : min;
      max = max == null || configured > max ? configured : max;
    });
    return [min, max];
  }

  nearestPresent(seriesIndex: number, index: number, bias: -1 | 0 | 1): number | null {
    this.assertSeriesIndex(seriesIndex);
    this.assertPointIndex(index);
    const constantIndex =
      this.getTransform(seriesIndex) === TRANSFORM_CONSTANT ? this.getConstantIndex(seriesIndex) : null;
    if (constantIndex != null) {
      if (bias < 0) {
        return constantIndex <= index ? constantIndex : null;
      }
      if (bias > 0) {
        return constantIndex >= index ? constantIndex : null;
      }
      return constantIndex;
    }

    const timestamp = this.xAt(index);
    const axis = this.getAxis(seriesIndex);
    if (bias !== 0) {
      return this.findPresentGlobalIndex(seriesIndex, axis, timestamp, bias);
    }

    if (this.yAt(seriesIndex, index) != null) {
      return index;
    }
    const left = this.findPresentGlobalIndex(seriesIndex, axis, timestamp, -1);
    const right = this.findPresentGlobalIndex(seriesIndex, axis, timestamp, 1);
    return left == null
      ? right
      : right == null || timestamp - this.xAt(left) <= this.xAt(right) - timestamp
        ? left
        : right;
  }

  private findPresentGlobalIndex(
    seriesIndex: number,
    axis: CompactTimeSeriesAxis,
    timestamp: number,
    direction: -1 | 1
  ): number | null {
    const localPosition = (timestamp - axis.start) / axis.step;
    const localStart =
      direction < 0 ? Math.min(axis.count - 1, Math.floor(localPosition)) : Math.max(0, Math.ceil(localPosition));
    if (localStart < 0 || localStart >= axis.count) {
      return null;
    }
    const localIndex = this.findPresentLocalIndex(seriesIndex, localStart, direction);
    if (localIndex == null) {
      return null;
    }
    if (this.alignment.isShared) {
      return localIndex;
    }
    return this.closestXIndex(axis.start + axis.step * localIndex, 0, this.pointCount - 1);
  }

  private findPresentLocalIndex(seriesIndex: number, start: number, direction: -1 | 1): number | null {
    const presenceByteLength = this.getPresenceByteLength(seriesIndex);
    const noValue = this.noValues[this.optionIds[seriesIndex]];
    if (!Number.isNaN(noValue)) {
      return start;
    }
    if (presenceByteLength === 0) {
      for (
        let localIndex = start;
        localIndex >= 0 && localIndex < this.getAxis(seriesIndex).count;
        localIndex += direction
      ) {
        if (this.readConfiguredLocalValue(seriesIndex, localIndex) != null) {
          return localIndex;
        }
      }
      return null;
    }

    const axisCount = this.getAxis(seriesIndex).count;
    const byteOffset = this.getPresenceByteOffset(seriesIndex);
    let localIndex = start;
    while (localIndex >= 0 && localIndex < axisCount) {
      const byteIndex = localIndex >> 3;
      const byte = this.bytes[byteOffset + byteIndex];
      if (byte !== 0) {
        const byteStart = byteIndex << 3;
        const byteEnd = Math.min(axisCount, byteStart + 8);
        for (let candidate = localIndex; candidate >= byteStart && candidate < byteEnd; candidate += direction) {
          if ((byte & (1 << (candidate & 7))) !== 0 && this.readConfiguredLocalValue(seriesIndex, candidate) != null) {
            return candidate;
          }
        }
      }
      localIndex = direction < 0 ? (byteIndex << 3) - 1 : (byteIndex + 1) << 3;
    }
    return null;
  }

  private scanShared(seriesIndex: number, from: number, to: number, visitor: CompactPointVisitor): void {
    const optionId = this.optionIds[seriesIndex];
    const transform = this.transforms[optionId];
    const constantIndex = transform === TRANSFORM_CONSTANT ? this.getConstantIndex(seriesIndex) : null;
    const spanNulls = this.spanNulls[optionId];

    if (transform === TRANSFORM_CONSTANT) {
      for (let index = from; index <= to; index++) {
        visitor(index, index === constantIndex ? this.yAt(seriesIndex, index) : undefined, this.xAt(index));
      }
      return;
    }

    const axis = this.getAxis(seriesIndex);
    const insertThreshold = this.getInsertThreshold(seriesIndex, axis);
    const needsGapClassification =
      this.getPresenceByteLength(seriesIndex) > 0 &&
      Number.isNaN(this.noValues[optionId]) &&
      spanNulls !== SPAN_NULLS_ALWAYS &&
      (insertThreshold > axis.step || Number.isFinite(spanNulls));
    if (needsGapClassification) {
      this.scanSharedGaps(seriesIndex, from, to, insertThreshold, spanNulls, visitor);
      return;
    }

    this.scanLocalValues(seriesIndex, from, to + 1, (sourceValue, localIndex) => {
      let value: CompactPlotValue = this.applyValueOptions(sourceValue, seriesIndex);
      if (constantIndex != null && localIndex !== constantIndex) {
        value = undefined;
      } else if (value == null && spanNulls === SPAN_NULLS_ALWAYS) {
        value = undefined;
      }
      visitor(localIndex, value, this.xAt(localIndex));
    });
  }

  private scanSharedGaps(
    seriesIndex: number,
    from: number,
    to: number,
    insertThreshold: number,
    spanNulls: number,
    visitor: CompactPointVisitor
  ): void {
    const axis = this.getAxis(seriesIndex);
    let previousValueIndex = from > 0 ? this.findPresentLocalIndex(seriesIndex, from - 1, -1) : null;
    let gapStart: number | null = null;
    this.scanLocalValues(seriesIndex, from, to + 1, (sourceValue, localIndex) => {
      const value: CompactPlotValue = this.applyValueOptions(sourceValue, seriesIndex);
      if (value == null) {
        gapStart ??= localIndex;
        return;
      }

      if (gapStart != null) {
        const previousTimestamp = previousValueIndex == null ? axis.start - axis.step : this.xAt(previousValueIndex);
        const nextTimestamp = this.xAt(localIndex);
        const connected = this.isGapConnected(
          previousTimestamp,
          nextTimestamp,
          insertThreshold,
          spanNulls,
          previousValueIndex != null,
          true
        );
        for (let gapIndex = Math.max(gapStart, from); gapIndex < Math.min(localIndex, to + 1); gapIndex++) {
          visitor(gapIndex, connected ? undefined : null, this.xAt(gapIndex));
        }
        gapStart = null;
      }
      if (localIndex >= from) {
        visitor(localIndex, value, this.xAt(localIndex));
      }
      previousValueIndex = localIndex;
    });
    if (gapStart != null) {
      const nextValueIndex = to + 1 < axis.count ? this.findPresentLocalIndex(seriesIndex, to + 1, 1) : null;
      const previousTimestamp = previousValueIndex == null ? axis.start - axis.step : this.xAt(previousValueIndex);
      const nextTimestamp = nextValueIndex == null ? axis.start + axis.step * axis.count : this.xAt(nextValueIndex);
      const connected = this.isGapConnected(
        previousTimestamp,
        nextTimestamp,
        insertThreshold,
        spanNulls,
        previousValueIndex != null,
        nextValueIndex != null
      );
      for (let gapIndex = Math.max(gapStart, from); gapIndex <= to; gapIndex++) {
        visitor(gapIndex, connected ? undefined : null, this.xAt(gapIndex));
      }
    }
  }

  private applyRenderSemantics(
    seriesIndex: number,
    globalIndex: number,
    axis: CompactTimeSeriesAxis,
    value: CompactPlotValue,
    timestamp = this.xAt(globalIndex)
  ): CompactPlotValue {
    if (this.getTransform(seriesIndex) === TRANSFORM_CONSTANT) {
      const constantIndex = this.getConstantIndex(seriesIndex);
      return constantIndex === globalIndex ? value : undefined;
    }
    if (value != null) {
      return value;
    }
    const spanNulls = this.getSpanNulls(seriesIndex);
    if (spanNulls === SPAN_NULLS_ALWAYS) {
      return undefined;
    }
    if (spanNulls === -1) {
      return value;
    }

    const hasPotentialSourceGap = value === null || this.alignedRunContainsSourceGap(seriesIndex, timestamp, axis);
    if (!hasPotentialSourceGap) {
      return undefined;
    }
    const localPosition = (timestamp - axis.start) / axis.step;
    const previous = this.findConfiguredTimestamp(seriesIndex, axis, Math.ceil(localPosition) - 1, -1);
    const next = this.findConfiguredTimestamp(seriesIndex, axis, Math.floor(localPosition) + 1, 1);
    const previousTimestamp = previous ?? axis.start - axis.step;
    const nextTimestamp = next ?? axis.start + axis.step * axis.count;
    if (
      this.isGapConnected(
        previousTimestamp,
        nextTimestamp,
        this.getInsertThreshold(seriesIndex, axis),
        spanNulls,
        previous != null,
        next != null
      )
    ) {
      return undefined;
    }
    return null;
  }

  private getInsertThreshold(seriesIndex: number, axis: CompactTimeSeriesAxis): number {
    const configured = this.insertNulls[this.optionIds[seriesIndex]];
    return Number.isFinite(configured) ? configured : axis.step;
  }

  private isGapConnected(
    previousTimestamp: number,
    nextTimestamp: number,
    insertThreshold: number,
    spanNulls: number,
    hasPreviousValue: boolean,
    hasNextValue: boolean
  ): boolean {
    const delta = nextTimestamp - previousTimestamp;
    return (
      delta <= insertThreshold ||
      spanNulls === SPAN_NULLS_ALWAYS ||
      (hasPreviousValue && hasNextValue && Number.isFinite(spanNulls) && spanNulls !== -1 && delta < spanNulls)
    );
  }

  private alignedRunContainsSourceGap(seriesIndex: number, timestamp: number, axis: CompactTimeSeriesAxis): boolean {
    const insertionIndex = Math.ceil((timestamp - axis.start) / axis.step);
    const leftIndex = insertionIndex - 1;
    const rightIndex = insertionIndex;
    return (
      (leftIndex >= 0 && leftIndex < axis.count && this.readConfiguredLocalValue(seriesIndex, leftIndex) == null) ||
      (rightIndex >= 0 && rightIndex < axis.count && this.readConfiguredLocalValue(seriesIndex, rightIndex) == null)
    );
  }

  private findConfiguredTimestamp(
    seriesIndex: number,
    axis: CompactTimeSeriesAxis,
    start: number,
    direction: -1 | 1
  ): number | null {
    for (let localIndex = start; localIndex >= 0 && localIndex < axis.count; localIndex += direction) {
      if (this.readConfiguredLocalValue(seriesIndex, localIndex) != null) {
        return axis.start + axis.step * localIndex;
      }
    }
    return null;
  }

  private readConfiguredLocalValue(seriesIndex: number, localIndex: number): number | null {
    return this.applyValueOptions(this.readRawLocalValue(seriesIndex, localIndex), seriesIndex);
  }

  private applyValueOptions(sourceValue: number | null, seriesIndex: number): number | null {
    let value = sourceValue;
    const optionId = this.optionIds[seriesIndex];
    if (value == null) {
      const noValue = this.noValues[optionId];
      if (!Number.isNaN(noValue)) {
        value = noValue;
      }
    }
    if (value != null && this.transforms[optionId] === TRANSFORM_NEGATIVE_Y) {
      value *= -1;
    }
    return value;
  }

  private getTransform(seriesIndex: number): number {
    return this.transforms[this.optionIds[seriesIndex]];
  }

  private getSpanNulls(seriesIndex: number): number {
    return this.spanNulls[this.optionIds[seriesIndex]];
  }

  private getConstantIndex(seriesIndex: number): number | null {
    if (this.constantIndexes.has(seriesIndex)) {
      return this.constantIndexes.get(seriesIndex)!;
    }
    const axis = this.getAxis(seriesIndex);
    const localIndex = axis.count > 0 ? this.findPresentLocalIndex(seriesIndex, 0, 1) : null;
    const constantIndex =
      localIndex == null
        ? null
        : this.alignment.isShared
          ? localIndex
          : this.closestXIndex(axis.start + axis.step * localIndex, 0, this.pointCount - 1);
    this.constantIndexes.set(seriesIndex, constantIndex);
    return constantIndex;
  }

  private scanLocalValues(
    seriesIndex: number,
    from: number,
    to: number,
    visitor: (value: number | null, localIndex: number) => void
  ): void {
    const presenceByteLength = this.getPresenceByteLength(seriesIndex);
    let packedIndex = presenceByteLength === 0 ? from : this.rankBefore(seriesIndex, from);
    for (let localIndex = from; localIndex < to; localIndex++) {
      if (presenceByteLength !== 0 && !this.isPresent(seriesIndex, localIndex)) {
        visitor(null, localIndex);
        continue;
      }
      const value = this.view.getFloat64(
        this.getValuesByteOffset(seriesIndex) + packedIndex * Float64Array.BYTES_PER_ELEMENT,
        true
      );
      packedIndex++;
      visitor(Number.isFinite(value) ? value : null, localIndex);
    }
  }

  private readRawLocalValue(seriesIndex: number, localIndex: number): number | null {
    if (!this.isPresent(seriesIndex, localIndex)) {
      return null;
    }
    const packedIndex =
      this.getPresenceByteLength(seriesIndex) === 0 ? localIndex : this.rankBefore(seriesIndex, localIndex);
    const value = this.view.getFloat64(
      this.getValuesByteOffset(seriesIndex) + packedIndex * Float64Array.BYTES_PER_ELEMENT,
      true
    );
    return Number.isFinite(value) ? value : null;
  }

  private isPresent(seriesIndex: number, localIndex: number): boolean {
    const byteLength = this.getPresenceByteLength(seriesIndex);
    return (
      byteLength === 0 ||
      (this.bytes[this.getPresenceByteOffset(seriesIndex) + (localIndex >> 3)] & (1 << (localIndex & 7))) !== 0
    );
  }

  private rankBefore(seriesIndex: number, localIndex: number): number {
    if (localIndex <= 0 || this.getPresenceByteLength(seriesIndex) === 0) {
      return localIndex;
    }
    const axis = this.getAxis(seriesIndex);
    let from = 0;
    let rank = 0;
    if (axis.count >= MIN_RANK_CHECKPOINT_POINTS && localIndex >= RANK_CHECKPOINT_STRIDE) {
      let checkpoints = this.rankCheckpoints.get(seriesIndex);
      if (!checkpoints) {
        checkpoints = this.buildRankCheckpoints(seriesIndex, axis.count);
        this.rankCheckpoints.set(seriesIndex, checkpoints);
      }
      const block = Math.floor(localIndex / RANK_CHECKPOINT_STRIDE);
      rank = checkpoints[block];
      from = block * RANK_CHECKPOINT_STRIDE;
    }
    return rank + this.countPresent(seriesIndex, from, localIndex);
  }

  private buildRankCheckpoints(seriesIndex: number, pointCount: number): Uint32Array {
    const blockCount = Math.ceil(pointCount / RANK_CHECKPOINT_STRIDE);
    const checkpoints = new Uint32Array(blockCount + 1);
    let rank = 0;
    for (let block = 1; block <= blockCount; block++) {
      rank += this.countPresent(
        seriesIndex,
        (block - 1) * RANK_CHECKPOINT_STRIDE,
        Math.min(block * RANK_CHECKPOINT_STRIDE, pointCount)
      );
      checkpoints[block] = rank;
    }
    return checkpoints;
  }

  private countPresent(seriesIndex: number, from: number, to: number): number {
    if (from >= to) {
      return 0;
    }
    const byteOffset = this.getPresenceByteOffset(seriesIndex);
    let count = 0;
    let index = from;
    while (index < to && (index & 7) !== 0) {
      count += (this.bytes[byteOffset + (index >> 3)] >> (index & 7)) & 1;
      index++;
    }
    while (index + 8 <= to) {
      count += POPCOUNT[this.bytes[byteOffset + (index >> 3)]];
      index += 8;
    }
    while (index < to) {
      count += (this.bytes[byteOffset + (index >> 3)] >> (index & 7)) & 1;
      index++;
    }
    return count;
  }

  private getAxis(seriesIndex: number): CompactTimeSeriesAxis {
    const axisId = this.getAxisId(seriesIndex);
    const axis = this.data.axes[axisId];
    if (!axis) {
      throw new Error(`Compact time series references missing axis ${axisId}`);
    }
    return axis;
  }

  private getAxisId(seriesIndex: number): number {
    if (isColumnarSeries(this.data.series)) {
      return this.data.series.columns.axisIds[this.data.series.resolveColumnIndex(seriesIndex)];
    }
    return this.data.series[seriesIndex].axisId;
  }

  private getPresenceByteOffset(seriesIndex: number): number {
    if (isColumnarSeries(this.data.series)) {
      return this.data.series.columns.presenceByteOffsets[this.data.series.resolveColumnIndex(seriesIndex)];
    }
    return this.data.series[seriesIndex].presenceByteOffset;
  }

  private getPresenceByteLength(seriesIndex: number): number {
    if (isColumnarSeries(this.data.series)) {
      return this.data.series.columns.presenceByteLengths[this.data.series.resolveColumnIndex(seriesIndex)];
    }
    return this.data.series[seriesIndex].presenceByteLength;
  }

  private getValuesByteOffset(seriesIndex: number): number {
    if (isColumnarSeries(this.data.series)) {
      return this.data.series.columns.valuesByteOffsets[this.data.series.resolveColumnIndex(seriesIndex)];
    }
    return this.data.series[seriesIndex].valuesByteOffset;
  }

  private assertSeriesIndex(seriesIndex: number): void {
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || seriesIndex >= this.seriesCount) {
      throw new RangeError(`Compact series index ${seriesIndex} is out of range`);
    }
  }

  private assertPointIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pointCount) {
      throw new RangeError(`Compact point index ${index} is out of range`);
    }
  }

  private assertInclusiveRange(from: number, to: number): void {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to >= this.pointCount) {
      throw new RangeError(`Compact point range [${from}, ${to}] is out of range`);
    }
  }
}

class CompactAxisAlignment {
  readonly isShared: boolean;
  readonly pointCount: number;
  private readonly checkpointPositions?: Uint32Array;
  private readonly checkpointStride: number;
  private readonly positionScratch: Uint32Array[];
  private scratchDepth = 0;

  constructor(
    private readonly axes: readonly CompactTimeSeriesAxis[],
    private readonly axisIds: readonly number[]
  ) {
    this.positionScratch = Array.from({ length: 4 }, () => new Uint32Array(axisIds.length));
    this.checkpointStride = 0;
    this.isShared = axisIds.length <= 1;
    if (axisIds.length === 0) {
      this.pointCount = 0;
      return;
    }
    if (this.isShared) {
      this.pointCount = this.getAxis(axisIds[0]).count;
      return;
    }

    this.pointCount = this.countUnionPoints();
    const maximumCheckpointCount = Math.floor(MAX_ALIGNMENT_CHECKPOINT_ENTRIES / axisIds.length);
    if (maximumCheckpointCount > 0) {
      this.checkpointStride = Math.max(RANK_CHECKPOINT_STRIDE, Math.ceil(this.pointCount / maximumCheckpointCount));
      this.checkpointPositions = this.buildUnionCheckpoints();
    }
  }

  xAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.pointCount) {
      throw new RangeError(`Compact point index ${index} is out of range`);
    }
    if (this.isShared) {
      const axis = this.getAxis(this.axisIds[0]);
      return axis.start + axis.step * index;
    }
    let value = 0;
    this.scan(index, index + 1, (_index, timestamp) => {
      value = timestamp;
    });
    return value;
  }

  localIndexAt(axisId: number, globalIndex: number): number {
    const axis = this.getAxis(axisId);
    const timestamp = this.xAt(globalIndex);
    const offset = timestamp - axis.start;
    if (offset < 0 || offset % axis.step !== 0) {
      return -1;
    }
    const localIndex = offset / axis.step;
    return localIndex < axis.count ? localIndex : -1;
  }

  scan(from: number, to: number, visitor: (index: number, timestamp: number) => void): void {
    if (this.isShared) {
      const axis = this.getAxis(this.axisIds[0]);
      for (let index = from; index < to; index++) {
        visitor(index, axis.start + axis.step * index);
      }
      return;
    }

    const positions = this.acquirePositionScratch();
    try {
      let index = this.restorePositions(from, positions);
      while (index < to) {
        const timestamp = this.nextTimestamp(positions);
        if (index >= from) {
          visitor(index, timestamp);
        }
        this.advancePositions(positions, timestamp);
        index++;
      }
    } finally {
      this.scratchDepth--;
    }
  }

  scanAxis(
    axisId: number,
    from: number,
    to: number,
    visitor: (index: number, timestamp: number, localIndex: number) => void
  ): void {
    if (this.isShared) {
      const axis = this.getAxis(axisId);
      for (let index = from; index < to; index++) {
        visitor(index, axis.start + axis.step * index, index < axis.count ? index : -1);
      }
      return;
    }

    const axisPosition = this.axisIds.indexOf(axisId);
    if (axisPosition < 0) {
      throw new Error(`Compact time series references unused axis ${axisId}`);
    }
    const axis = this.getAxis(axisId);
    const positions = this.acquirePositionScratch();
    try {
      let index = this.restorePositions(from, positions);
      while (index < to) {
        const timestamp = this.nextTimestamp(positions);
        const localIndex =
          positions[axisPosition] < axis.count && axis.start + axis.step * positions[axisPosition] === timestamp
            ? positions[axisPosition]
            : -1;
        if (index >= from) {
          visitor(index, timestamp, localIndex);
        }
        this.advancePositions(positions, timestamp);
        index++;
      }
    } finally {
      this.scratchDepth--;
    }
  }

  private restorePositions(from: number, positions: Uint32Array): number {
    if (!this.checkpointPositions) {
      positions.fill(0);
      return 0;
    }
    const checkpoint = Math.floor(from / this.checkpointStride);
    const checkpointOffset = checkpoint * this.axisIds.length;
    for (let axisIndex = 0; axisIndex < this.axisIds.length; axisIndex++) {
      positions[axisIndex] = this.checkpointPositions[checkpointOffset + axisIndex];
    }
    return checkpoint * this.checkpointStride;
  }

  private countUnionPoints(): number {
    const positions = new Uint32Array(this.axisIds.length);
    let count = 0;
    while (true) {
      const timestamp = this.nextTimestamp(positions);
      if (timestamp === Infinity) {
        return count;
      }
      this.advancePositions(positions, timestamp);
      count++;
    }
  }

  private buildUnionCheckpoints(): Uint32Array {
    const checkpointCount = Math.ceil(this.pointCount / this.checkpointStride);
    const checkpointPositions = new Uint32Array(checkpointCount * this.axisIds.length);
    const positions = new Uint32Array(this.axisIds.length);
    for (let index = 0; index < this.pointCount; index++) {
      if (index % this.checkpointStride === 0) {
        const checkpoint = index / this.checkpointStride;
        checkpointPositions.set(positions, checkpoint * this.axisIds.length);
      }
      const timestamp = this.nextTimestamp(positions);
      this.advancePositions(positions, timestamp);
    }
    return checkpointPositions;
  }

  private acquirePositionScratch(): Uint32Array {
    const positions = this.positionScratch[this.scratchDepth];
    if (!positions) {
      throw new Error('Compact axis lookup exceeded supported reentrancy');
    }
    this.scratchDepth++;
    return positions;
  }

  private nextTimestamp(positions: Uint32Array): number {
    let timestamp = Infinity;
    for (let index = 0; index < this.axisIds.length; index++) {
      const axis = this.getAxis(this.axisIds[index]);
      if (positions[index] < axis.count) {
        timestamp = Math.min(timestamp, axis.start + axis.step * positions[index]);
      }
    }
    return timestamp;
  }

  private advancePositions(positions: Uint32Array, timestamp: number): void {
    for (let index = 0; index < this.axisIds.length; index++) {
      const axis = this.getAxis(this.axisIds[index]);
      if (positions[index] < axis.count && axis.start + axis.step * positions[index] === timestamp) {
        positions[index]++;
      }
    }
  }

  private getAxis(axisId: number): CompactTimeSeriesAxis {
    const axis = this.axes[axisId];
    if (!axis) {
      throw new Error(`Compact time series references missing axis ${axisId}`);
    }
    return axis;
  }
}

function collectAxisIds(data: CompactTimeSeriesData): number[] {
  const axisIds: number[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < data.series.length; index++) {
    const axisId = getSeriesAxisId(data, index);
    if (!seen.has(axisId)) {
      seen.add(axisId);
      axisIds.push(axisId);
    }
  }
  return axisIds;
}

function findPlotOptionId(
  options: Map<number, Map<number, Map<number, Map<number, number>>>>,
  noValue: number,
  transform: number,
  spanNulls: number,
  insertNulls: number
): number | undefined {
  return options.get(noValue)?.get(transform)?.get(spanNulls)?.get(insertNulls);
}

function setPlotOptionId(
  options: Map<number, Map<number, Map<number, Map<number, number>>>>,
  noValue: number,
  transform: number,
  spanNulls: number,
  insertNulls: number,
  id: number
): void {
  let byTransform = options.get(noValue);
  if (!byTransform) {
    byTransform = new Map();
    options.set(noValue, byTransform);
  }
  let bySpanNulls = byTransform.get(transform);
  if (!bySpanNulls) {
    bySpanNulls = new Map();
    byTransform.set(transform, bySpanNulls);
  }
  let byInsertNulls = bySpanNulls.get(spanNulls);
  if (!byInsertNulls) {
    byInsertNulls = new Map();
    bySpanNulls.set(spanNulls, byInsertNulls);
  }
  byInsertNulls.set(insertNulls, id);
}

function getSeriesAxisId(data: CompactTimeSeriesData, index: number): number {
  if (isColumnarSeries(data.series)) {
    return data.series.columns.axisIds[data.series.resolveColumnIndex(index)];
  }
  return data.series[index].axisId;
}

function isColumnarSeries(
  series: CompactTimeSeriesData['series']
): series is Exclude<CompactTimeSeriesData['series'], readonly CompactTimeSeriesSeries[]> {
  return !Array.isArray(series);
}
