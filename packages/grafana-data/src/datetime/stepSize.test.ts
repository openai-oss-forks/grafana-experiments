import { dateTime } from './moment_wrapper';
import { ALLOWED_STEP_SIZES, getStepSizeOptions, isValidStepSize, resolveQueryIntervalWithStepSize } from './stepSize';

describe('stepSize', () => {
  it('exposes only curated step size options', () => {
    expect(ALLOWED_STEP_SIZES).toEqual(['1m', '5m', '10m', '20m', '30m', '1h', '2h', '5h']);
    expect(getStepSizeOptions().map((option) => option.value)).toEqual([
      '',
      '1m',
      '5m',
      '10m',
      '20m',
      '30m',
      '1h',
      '2h',
      '5h',
    ]);
  });

  it('rejects arbitrary step size durations', () => {
    expect(isValidStepSize('10m')).toBe(true);
    expect(isValidStepSize('2m')).toBe(false);
    expect(isValidStepSize('3m')).toBe(false);
  });

  it('uses a curated explicit step size', () => {
    const interval = resolveQueryIntervalWithStepSize({
      range: {
        from: dateTime('2023-10-12T12:00:00Z'),
        to: dateTime('2023-10-13T00:00:00Z'),
        raw: { from: 'now-12h', to: 'now' },
      },
      maxDataPoints: 1000,
      minInterval: '15s',
      stepSize: '5m',
    });

    expect(interval).toMatchObject({
      interval: '5m',
      intervalMs: 300000,
      maxDataPoints: 1500,
      stepSize: '5m',
    });
  });
});
