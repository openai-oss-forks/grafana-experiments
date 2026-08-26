import { systemDateFormats, SystemDateFormatsState } from './formats';
import { dateTimeParse } from './parser';

describe('dateTimeParse', () => {
  it('should evaluate relative dates from the supplied current time', () => {
    const now = Date.parse('2024-07-05T12:00:00.000Z');
    const date = dateTimeParse('now-6h', { timeZone: 'utc', now });

    expect(date.toISOString()).toBe('2024-07-05T06:00:00.000Z');
  });

  it('should accept the Unix epoch as the current time', () => {
    const date = dateTimeParse('now', { timeZone: 'utc', now: 0 });

    expect(date.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('should round the supplied current time in the requested timezone', () => {
    const now = Date.parse('2024-07-05T02:00:00.000Z');
    const date = dateTimeParse('now/d', { timeZone: 'America/New_York', roundUp: true, now });

    expect(date.toISOString()).toBe('2024-07-05T03:59:59.999Z');
  });

  it('should round the supplied current time to the requested fiscal quarter', () => {
    const now = Date.parse('2024-07-05T12:00:00.000Z');
    const date = dateTimeParse('now/fQ', { timeZone: 'utc', fiscalYearStartMonth: 7, roundUp: true, now });

    expect(date.toISOString()).toBe('2024-07-31T23:59:59.999Z');
  });

  it('should parse using the systems configured timezone', () => {
    const date = dateTimeParse('2020-03-02 15:00:22');
    expect(date.format()).toEqual('2020-03-02T15:00:22-05:00');
  });

  it('should be able to parse using default format', () => {
    const date = dateTimeParse('2020-03-02 15:00:22', { timeZone: 'utc' });
    expect(date.format()).toEqual('2020-03-02T15:00:22Z');
  });

  it('should be able to parse using default format', () => {
    systemDateFormats.update({
      fullDate: 'MMMM D, YYYY, h:mm:ss a',
      interval: {} as SystemDateFormatsState['interval'],
      useBrowserLocale: false,
    });

    const date = dateTimeParse('Aug 20, 2020 10:30:20 am', { timeZone: 'utc' });
    expect(date.format()).toEqual('2020-08-20T10:30:20Z');
  });

  it('should be able to parse ISO 8601 date strings when useBrowserLocale is true', () => {
    systemDateFormats.update({
      fullDate: 'YYYY-MM-DD HH:mm:ss.SSS',
      interval: {} as SystemDateFormatsState['interval'],
      useBrowserLocale: true,
    });

    const date = dateTimeParse('2025-03-12T07:09:37.253Z', { timeZone: 'browser' });
    expect(date.isValid()).toBe(true);
    expect(date.format()).toEqual('2025-03-12T07:09:37Z');
  });

  it('should be able to parse array formats used by calendar', () => {
    const date = dateTimeParse([2020, 5, 10, 10, 30, 20], { timeZone: 'utc' });
    expect(date.format()).toEqual('2020-06-10T10:30:20Z');
  });
});
