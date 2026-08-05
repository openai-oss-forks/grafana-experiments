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
