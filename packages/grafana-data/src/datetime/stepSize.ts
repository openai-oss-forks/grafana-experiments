import * as rangeUtil from './rangeutil';
import { type SelectableValue } from '../types/select';
import { type TimeRange } from '../types/time';

export const MAX_STEP_SIZE_DATA_POINTS = 1500;
export const AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS = MAX_STEP_SIZE_DATA_POINTS;

export const ALLOWED_STEP_SIZES = ['1m', '2m', '5m', '10m', '20m', '30m', '1h', '2h', '5h'] as const;

export type QueryStepSize = (typeof ALLOWED_STEP_SIZES)[number];

const STEP_SIZE_LABELS: Record<QueryStepSize, string> = {
  '1m': '1m',
  '2m': '2m',
  '5m': '5m',
  '10m': '10m',
  '20m': '20m',
  '30m': '30m',
  '1h': '1 hr',
  '2h': '2 hr',
  '5h': '5 hr',
};

const STEP_SIZE_MS = ALLOWED_STEP_SIZES.reduce<Record<QueryStepSize, number>>(
  (acc, stepSize) => {
    acc[stepSize] = rangeUtil.intervalToMs(stepSize);
    return acc;
  },
  {} as Record<QueryStepSize, number>
);

export interface QueryIntervalWithStepSize {
  interval: string;
  intervalMs: number;
  maxDataPoints: number;
  stepSize?: string | null;
  minInterval?: string | null;
}

export interface ResolveQueryIntervalWithStepSizeOptions {
  range: TimeRange;
  maxDataPoints: number;
  minInterval?: string | null;
  stepSize?: string | null;
}

export function isValidStepSize(value?: string | null): value is QueryStepSize {
  return ALLOWED_STEP_SIZES.includes(value as QueryStepSize);
}

export function getStepSizeMs(stepSize: QueryStepSize): number {
  return STEP_SIZE_MS[stepSize];
}

export function safeIntervalToMs(interval?: string | null): number | undefined {
  if (!interval) {
    return undefined;
  }

  try {
    const intervalMs = rangeUtil.intervalToMs(interval);
    return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined;
  } catch {
    return undefined;
  }
}

export function isStepSizeBelowMinInterval(stepSize?: string | null, minInterval?: string | null): boolean {
  if (!isValidStepSize(stepSize)) {
    return false;
  }

  const minIntervalMs = safeIntervalToMs(minInterval);
  return minIntervalMs !== undefined && getStepSizeMs(stepSize) < minIntervalMs;
}

export function getStepSizeOptions(minInterval?: string | null): Array<SelectableValue<string>> {
  const minIntervalMs = safeIntervalToMs(minInterval);

  return [
    { label: 'Auto', value: '' },
    ...ALLOWED_STEP_SIZES.map((stepSize) => {
      const isDisabled = minIntervalMs !== undefined && getStepSizeMs(stepSize) < minIntervalMs;
      return {
        label: STEP_SIZE_LABELS[stepSize],
        value: stepSize,
        isDisabled,
        description: isDisabled ? `Below min interval ${minInterval}` : undefined,
      };
    }),
  ];
}

export function getDatapointsForStep(range: TimeRange, stepMs: number): number {
  const rangeMs = Math.max(0, range.to.valueOf() - range.from.valueOf());
  return Math.floor(rangeMs / stepMs) + 1;
}

export function resolveQueryIntervalWithStepSize({
  range,
  maxDataPoints,
  minInterval,
  stepSize,
}: ResolveQueryIntervalWithStepSizeOptions): QueryIntervalWithStepSize {
  if (!stepSize || !isValidStepSize(stepSize)) {
    const norm = rangeUtil.calculateInterval(range, maxDataPoints, minInterval ?? undefined);
    return {
      interval: norm.interval,
      intervalMs: norm.intervalMs,
      maxDataPoints,
      stepSize,
      minInterval,
    };
  }

  const requestedStepMs = getStepSizeMs(stepSize);
  const minIntervalMs = safeIntervalToMs(minInterval) ?? 0;
  const minimumStepMs = Math.max(requestedStepMs, minIntervalMs);
  const clampedStepSize = ALLOWED_STEP_SIZES.find((candidate) => {
    const candidateMs = getStepSizeMs(candidate);
    return candidateMs >= minimumStepMs && getDatapointsForStep(range, candidateMs) <= MAX_STEP_SIZE_DATA_POINTS;
  });

  if (clampedStepSize) {
    const intervalMs = getStepSizeMs(clampedStepSize);
    return {
      interval: clampedStepSize,
      intervalMs,
      maxDataPoints: MAX_STEP_SIZE_DATA_POINTS,
      stepSize,
      minInterval,
    };
  }

  const safeMaxDataPoints =
    Number.isFinite(maxDataPoints) && maxDataPoints > 0
      ? Math.min(maxDataPoints, AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS)
      : AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS;
  const norm = rangeUtil.calculateInterval(range, safeMaxDataPoints, minInterval ?? undefined);
  return {
    interval: norm.interval,
    intervalMs: norm.intervalMs,
    maxDataPoints: safeMaxDataPoints,
    stepSize,
    minInterval,
  };
}
