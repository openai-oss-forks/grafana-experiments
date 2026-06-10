import { render, screen } from '@testing-library/react';
import createMockRaf from 'mock-raf';
import uPlot from 'uplot';

import { FieldConfig, FieldType, MutableDataFrame } from '@grafana/data';
import { GraphFieldConfig, GraphDrawStyle } from '@grafana/schema';

import { UPlotChart } from './Plot';
import { CompactRenderSource } from './compactRenderer';
import { UPlotConfigBuilder } from './config/UPlotConfigBuilder';
import { SeriesProps } from './config/UPlotSeriesBuilder';
import { preparePlotData2, getStackingGroups } from './utils';

const mockRaf = createMockRaf();
const setDataMock = jest.fn();
const setCompactDataMock = jest.fn();
const setSizeMock = jest.fn();
const initializeMock = jest.fn();
const destroyMock = jest.fn();

jest.mock('uplot', () => {
  const mock = Object.assign(
    jest.fn().mockImplementation(() => {
      return {
        setData: setDataMock,
        setSize: setSizeMock,
        initialize: initializeMock,
        destroy: destroyMock,
      };
    }),
    {
      compact: jest.fn(() => ({
        setCompactData: setCompactDataMock,
        setSize: setSizeMock,
        destroy: destroyMock,
      })),
    }
  );
  return mock;
});

const mockData = () => {
  const data = new MutableDataFrame();

  data.addField({
    type: FieldType.time,
    name: 'Time',
    values: [1602630000000, 1602633600000, 1602637200000],
    config: {},
  });

  data.addField({
    type: FieldType.number,
    name: 'Value',
    values: [10, 20, 5],
    config: {
      custom: {
        drawStyle: GraphDrawStyle.Line,
      },
    } as FieldConfig<GraphFieldConfig>,
  });

  const config = new UPlotConfigBuilder();
  config.addSeries({} as SeriesProps);
  return { data: data, config };
};

describe('UPlotChart', () => {
  beforeEach(() => {
    // @ts-ignore
    uPlot.mockClear();
    setDataMock.mockClear();
    setCompactDataMock.mockClear();
    setSizeMock.mockClear();
    initializeMock.mockClear();
    destroyMock.mockClear();
    jest.mocked(uPlot.compact).mockClear();

    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(mockRaf.raf);
  });

  it('destroys uPlot instance when component unmounts', () => {
    const { data, config } = mockData();
    const plotRef = jest.fn();

    const { unmount } = render(
      <UPlotChart
        data={preparePlotData2(data, getStackingGroups(data))} // mock
        config={config}
        width={100}
        height={100}
        plotRef={plotRef}
      />
    );

    expect(uPlot).toBeCalledTimes(1);
    expect(plotRef).toHaveBeenLastCalledWith(expect.any(Object));
    unmount();
    expect(destroyMock).toBeCalledTimes(1);
    expect(plotRef).toHaveBeenCalledTimes(1);
  });

  describe('data update', () => {
    it('skips uPlot reinitialization when there are no field config changes', () => {
      const { data, config } = mockData();

      const { rerender } = render(
        <UPlotChart
          data={preparePlotData2(data, getStackingGroups(data))} // mock
          config={config}
          width={100}
          height={100}
        />
      );

      expect(uPlot).toBeCalledTimes(1);

      data.fields[1].values.set(0, 1);

      rerender(
        <UPlotChart
          data={preparePlotData2(data, getStackingGroups(data))} // changed
          config={config}
          width={100}
          height={100}
        />
      );

      expect(setDataMock).toBeCalledTimes(1);
    });

    it('keeps compact updates on the response-backed source path', () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const { rerender } = render(<UPlotChart data={first} config={config} width={100} height={100} />);

      expect(uPlot.compact).toHaveBeenCalledWith(
        expect.any(Object),
        first,
        expect.any(Object),
        expect.any(HTMLElement)
      );
      expect(uPlot).not.toHaveBeenCalled();

      rerender(<UPlotChart data={second} config={config} width={100} height={100} />);

      expect(uPlot.compact).toHaveBeenCalledTimes(1);
      expect(setCompactDataMock).toHaveBeenCalledWith(second);
      expect(setDataMock).not.toHaveBeenCalled();
    });
  });

  describe('config update', () => {
    it('skips compact uPlot initialization until both dimensions are renderable', () => {
      const { config } = mockData();
      const data = mockCompactSource([10, 20, 5]);
      const { rerender } = render(<UPlotChart data={data} config={config} width={0} height={0} />);

      expect(screen.queryAllByTestId('uplot-main-div')).toHaveLength(1);
      expect(uPlot.compact).not.toBeCalled();

      rerender(<UPlotChart data={data} config={config} width={100} height={0} />);
      expect(uPlot.compact).not.toBeCalled();

      rerender(<UPlotChart data={data} config={config} width={100} height={100} />);
      expect(uPlot.compact).toBeCalledTimes(1);
    });

    it('destroys a compact plot when it becomes zero-sized and reinitializes when renderable', () => {
      const { config } = mockData();
      const data = mockCompactSource([10, 20, 5]);
      const { rerender } = render(<UPlotChart data={data} config={config} width={100} height={100} />);

      rerender(<UPlotChart data={data} config={config} width={0} height={100} />);

      expect(destroyMock).toBeCalledTimes(1);
      expect(setDataMock).not.toBeCalled();

      rerender(<UPlotChart data={data} config={config} width={100} height={100} />);

      expect(destroyMock).toBeCalledTimes(1);
      expect(uPlot.compact).toBeCalledTimes(2);
      expect(setDataMock).not.toBeCalled();
    });

    it('preserves legacy setSize behavior for a temporarily zero dimension', () => {
      const { data, config } = mockData();
      const alignedData = preparePlotData2(data, getStackingGroups(data));
      const { rerender } = render(<UPlotChart data={alignedData} config={config} width={100} height={100} />);

      rerender(<UPlotChart data={alignedData} config={config} width={0} height={100} />);

      expect(destroyMock).not.toHaveBeenCalled();
      expect(setSizeMock).toHaveBeenCalledWith({ width: 0, height: 100 });
    });

    it('reinitializes uPlot when config changes', () => {
      const { data, config } = mockData();

      const { rerender } = render(
        <UPlotChart
          data={preparePlotData2(data, getStackingGroups(data))} // frame
          config={config}
          width={100}
          height={100}
        />
      );

      expect(uPlot).toBeCalledTimes(1);

      const nextConfig = new UPlotConfigBuilder();
      nextConfig.addSeries({} as SeriesProps);

      rerender(
        <UPlotChart
          data={preparePlotData2(data, getStackingGroups(data))}
          config={nextConfig}
          width={100}
          height={100}
        />
      );

      expect(destroyMock).toBeCalledTimes(1);
      expect(uPlot).toBeCalledTimes(2);
    });

    it('skips uPlot reinitialization when only dimensions change', () => {
      const { data, config } = mockData();

      const { rerender } = render(
        <UPlotChart
          data={preparePlotData2(data, getStackingGroups(data))} // frame
          config={config}
          width={100}
          height={100}
        />
      );

      // we wait 1 frame for plugins initialisation logic to finish
      rerender(
        <UPlotChart
          data={preparePlotData2(data, getStackingGroups(data))} // frame
          config={config}
          width={200}
          height={200}
        />
      );

      expect(destroyMock).toBeCalledTimes(0);
      expect(uPlot).toBeCalledTimes(1);
      expect(setSizeMock).toBeCalledTimes(1);
    });

    it('preserves legacy update ordering when dimensions and data change together', () => {
      const { data, config } = mockData();

      const { rerender } = render(
        <UPlotChart data={preparePlotData2(data, getStackingGroups(data))} config={config} width={100} height={100} />
      );

      data.fields[1].values.set(0, 1);

      rerender(
        <UPlotChart data={preparePlotData2(data, getStackingGroups(data))} config={config} width={200} height={200} />
      );

      expect(setSizeMock).toBeCalledTimes(1);
      expect(setDataMock).not.toHaveBeenCalled();
    });

    it('updates compact source ownership when dimensions and data change together', () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const { rerender } = render(<UPlotChart data={first} config={config} width={100} height={100} />);

      rerender(<UPlotChart data={second} config={config} width={200} height={200} />);

      expect(setSizeMock).toHaveBeenCalledTimes(1);
      expect(setCompactDataMock).toHaveBeenCalledWith(second);
      expect(setDataMock).not.toHaveBeenCalled();
    });
  });
});

function mockCompactSource(values: number[]): CompactRenderSource {
  const buffer = new Float64Array(values).buffer;
  return {
    kind: 'compact-v1',
    buffer,
    pointCount: values.length,
    seriesCount: 1,
    columns: {
      styleIds: new Uint8Array([0]),
      scaleIds: new Uint8Array([0]),
      flags: new Uint8Array([0]),
      visibility: new Uint8Array([1]),
      stackGroupIds: new Uint8Array([0]),
    },
    styles: [{ stroke: '#f00' }],
    scales: [{ key: 'y' }],
    stackGroupCount: 0,
    cursorMode: 'single',
    visibilityState: { overrides: new Map() },
    release: () => undefined,
    xAt: (index) => 1000 + index * 1000,
    closestXIndex: (value, from, to) => Math.max(from, Math.min(to, Math.round((value - 1000) / 1000))),
    cursorValueAt: (_seriesIndex, index) => values[index],
    yAt: (_seriesIndex, index) => values[index],
    scan: (_seriesIndex, from, to, visitor) => {
      for (let index = from; index <= to; index++) {
        visitor(index, values[index]);
      }
    },
    prepareBufferScan: () => false,
    extent: () => [Math.min(...values), Math.max(...values)],
    nearestPresent: (_seriesIndex, index) => index,
  };
}
