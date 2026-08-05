import { CompactTimeSeriesData, CompactTimeSeriesSeriesCollection } from './compactTimeSeries';
import { DataFrame } from './dataFrame';
import { getPanelDataSeriesCount, limitPanelDataSeries } from './panel';

describe('shared panel series limits', () => {
  const frames = [{ name: 'A' }, { name: 'B' }, { name: 'C' }] as DataFrame[];

  it('counts and limits ordinary data frames', () => {
    const data = { series: frames };

    expect(getPanelDataSeriesCount(data)).toBe(3);
    expect(limitPanelDataSeries(data, 2).series).toEqual(frames.slice(0, 2));
  });

  it('counts and limits compact array-backed series without expanding them', () => {
    const series = [{ refId: 'A' }, { refId: 'B' }, { refId: 'C' }];
    const compactSeries = { series } as unknown as CompactTimeSeriesData;
    const data = { series: [], compactSeries };

    expect(getPanelDataSeriesCount(data)).toBe(3);
    expect(limitPanelDataSeries(data, 2).compactSeries?.series).toEqual(series.slice(0, 2));
  });

  it('limits column-backed series through their lazy prefix view', () => {
    const prefix = { length: 2 } as CompactTimeSeriesSeriesCollection;
    const take = jest.fn(() => prefix);
    const compactSeries = { series: { length: 3, take } } as unknown as CompactTimeSeriesData;
    const data = { series: [], compactSeries };

    const limited = limitPanelDataSeries(data, 2);

    expect(take).toHaveBeenCalledWith(2);
    expect(limited.compactSeries?.series).toBe(prefix);
  });

  it('counts ordinary and compact series together', () => {
    const compactSeries = { series: [{ refId: 'C' }, { refId: 'D' }] } as unknown as CompactTimeSeriesData;

    expect(getPanelDataSeriesCount({ series: frames.slice(0, 2), compactSeries })).toBe(4);
  });

  it('shares one limit across ordinary frames and compact array-backed series', () => {
    const compactFrames = [{ refId: 'C' }, { refId: 'D' }, { refId: 'E' }];
    const compactSeries = { series: compactFrames } as unknown as CompactTimeSeriesData;
    const data = { series: frames.slice(0, 2), compactSeries };

    const limited = limitPanelDataSeries(data, 3);

    expect(limited.series).toEqual(frames.slice(0, 2));
    expect(limited.compactSeries?.series).toEqual(compactFrames.slice(0, 1));
    expect(getPanelDataSeriesCount(limited)).toBe(3);
  });

  it('gives column-backed compact series only the remaining shared capacity', () => {
    const prefix = { length: 1 } as CompactTimeSeriesSeriesCollection;
    const take = jest.fn(() => prefix);
    const compactSeries = { series: { length: 3, take } } as unknown as CompactTimeSeriesData;

    const limited = limitPanelDataSeries({ series: frames.slice(0, 2), compactSeries }, 3);

    expect(take).toHaveBeenCalledWith(1);
    expect(limited.compactSeries?.series).toBe(prefix);
  });

  it('does not exceed the limit when ordinary frames fill all available capacity', () => {
    const compactSeries = { series: [{ refId: 'D' }] } as unknown as CompactTimeSeriesData;

    const limited = limitPanelDataSeries({ series: frames, compactSeries }, 2);

    expect(limited.series).toEqual(frames.slice(0, 2));
    expect(limited.compactSeries?.series).toEqual([]);
    expect(getPanelDataSeriesCount(limited)).toBe(2);
  });

  it.each([undefined, 0])('keeps data unchanged when the configured limit is %s', (seriesLimit) => {
    const data = { series: frames };

    expect(limitPanelDataSeries(data, seriesLimit)).toBe(data);
  });

  it('keeps all ordinary and compact series when the user requests Show all', () => {
    const compactSeries = { series: [{}, {}, {}] } as unknown as CompactTimeSeriesData;
    const data = { series: frames, compactSeries };

    expect(limitPanelDataSeries(data, 2, true)).toBe(data);
  });
});
