import { dateTime } from '@grafana/data';

import {
  AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS,
  getDatapointsForStep,
  getStepSizeMs,
  getStepSizeOptions,
  isStepSizeBelowMinInterval,
  isValidStepSize,
  MAX_STEP_SIZE_DATA_POINTS,
  resolveQueryIntervalWithStepSize,
} from './stepSize';

const range = (from: string, to: string) => ({
  from: dateTime(from),
  to: dateTime(to),
  raw: { from, to },
});

describe('stepSize helpers', () => {
  it('validates only approved persisted values', () => {
    expect(isValidStepSize('1m')).toBe(true);
    expect(isValidStepSize('5h')).toBe(true);
    expect(isValidStepSize('605s')).toBe(false);
    expect(isValidStepSize('1hr')).toBe(false);
  });

  it('detects step sizes below the effective min interval', () => {
    expect(isStepSizeBelowMinInterval('5m', '10m')).toBe(true);
    expect(isStepSizeBelowMinInterval('5m', '5m')).toBe(false);
    expect(isStepSizeBelowMinInterval('10m', '5m')).toBe(false);
    expect(isStepSizeBelowMinInterval('605s', '10m')).toBe(false);
  });

  it('marks select options below the effective min interval as disabled', () => {
    const options = getStepSizeOptions('20m');

    expect(options.find((option) => option.value === '10m')?.isDisabled).toBe(true);
    expect(options.find((option) => option.value === '20m')?.isDisabled).toBe(false);
    expect(options.find((option) => option.value === '1h')?.isDisabled).toBe(false);
  });

  it('keeps auto interval behavior when step size is unset or invalid', () => {
    const timeRange = range('2023-01-01T00:00:00Z', '2023-01-02T00:00:00Z');

    expect(resolveQueryIntervalWithStepSize({ range: timeRange, maxDataPoints: 200 }).interval).toBe('5m');
    expect(resolveQueryIntervalWithStepSize({ range: timeRange, maxDataPoints: 200, stepSize: '605s' }).interval).toBe(
      '5m'
    );
  });

  it('uses the requested step size when it stays under the datapoint cap', () => {
    const timeRange = range('2023-01-01T00:00:00Z', '2023-01-08T00:00:00Z');

    const interval = resolveQueryIntervalWithStepSize({
      range: timeRange,
      maxDataPoints: 200,
      stepSize: '30m',
    });

    expect(interval.interval).toBe('30m');
    expect(interval.intervalMs).toBe(getStepSizeMs('30m'));
    expect(interval.maxDataPoints).toBe(MAX_STEP_SIZE_DATA_POINTS);
    expect(getDatapointsForStep(timeRange, getStepSizeMs('30m'))).toBe(337);
  });

  it('keeps the per-series cap when the selected step has fewer points', () => {
    const timeRange = range('2023-01-01T00:00:00Z', '2023-01-01T06:00:00Z');

    const interval = resolveQueryIntervalWithStepSize({
      range: timeRange,
      maxDataPoints: 361,
      stepSize: '1m',
    });

    expect(interval.interval).toBe('1m');
    expect(interval.intervalMs).toBe(getStepSizeMs('1m'));
    expect(interval.maxDataPoints).toBe(MAX_STEP_SIZE_DATA_POINTS);
    expect(getDatapointsForStep(timeRange, getStepSizeMs('1m'))).toBe(361);
  });

  it('clamps upward to the next approved step under 1500 datapoints', () => {
    const timeRange = range('2023-01-01T00:00:00Z', '2023-01-08T00:00:00Z');

    const interval = resolveQueryIntervalWithStepSize({
      range: timeRange,
      maxDataPoints: 2000,
      stepSize: '1m',
    });

    expect(interval.interval).toBe('10m');
    expect(interval.maxDataPoints).toBe(MAX_STEP_SIZE_DATA_POINTS);
  });

  it('clamps upward to the effective min interval', () => {
    const timeRange = range('2023-01-01T00:00:00Z', '2023-01-02T00:00:00Z');

    const interval = resolveQueryIntervalWithStepSize({
      range: timeRange,
      maxDataPoints: 200,
      minInterval: '20m',
      stepSize: '5m',
    });

    expect(interval.interval).toBe('20m');
    expect(interval.intervalMs).toBe(getStepSizeMs('20m'));
  });

  it('falls back to auto interval capped at 1500 points when no approved step is large enough', () => {
    const timeRange = range('2023-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

    const interval = resolveQueryIntervalWithStepSize({
      range: timeRange,
      maxDataPoints: 5000,
      stepSize: '5h',
    });

    expect(interval.maxDataPoints).toBe(AUTO_STEP_SIZE_FALLBACK_MAX_DATA_POINTS);
    expect(interval.interval).not.toBe('5h');
  });
});
