import { act, render, screen } from '@testing-library/react';
import createMockRaf from 'mock-raf';
import uPlot from 'uplot';

import { FieldConfig, FieldType, MutableDataFrame } from '@grafana/data';
import { GraphFieldConfig, GraphDrawStyle } from '@grafana/schema';

import { UPlotChart } from './Plot';
import { CompactRenderSource, getCompactRenderController } from './compactRenderer';
import { UPlotConfigBuilder } from './config/UPlotConfigBuilder';
import { SeriesProps } from './config/UPlotSeriesBuilder';
import { preparePlotData2, getStackingGroups } from './utils';

const mockRaf = createMockRaf();
const setDataMock = jest.fn();
const setCompactDataMock = jest.fn();
const setSizeMock = jest.fn();
const initializeMock = jest.fn();
const destroyMock = jest.fn();
let compactDrawHooks: Array<(plot: uPlot) => void> = [];
let compactPlot: uPlot;
let drawCompactOnSetSize = false;
let compactSetSizeEffect: (() => void) | undefined;

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
      compact: jest.fn((options, source) => {
        compactDrawHooks = options.hooks?.draw ?? [];
        compactPlot = {
          compactSource: source,
          width: options.width,
          height: options.height,
          setCompactData: (nextSource: uPlot.CompactPlotSource) => {
            setCompactDataMock(nextSource);
            Reflect.set(compactPlot, 'compactSource', nextSource);
          },
          setSize: (size: { width: number; height: number }) => {
            Object.assign(compactPlot, size);
            compactSetSizeEffect?.();
            if (drawCompactOnSetSize) {
              compactDrawHooks.forEach((hook) => hook(compactPlot));
            }
            setSizeMock(size);
          },
          destroy: destroyMock,
        } as unknown as uPlot;
        return compactPlot;
      }),
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
    compactDrawHooks = [];
    drawCompactOnSetSize = false;
    compactSetSizeEffect = undefined;
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

    it('coalesces compact revisions behind an active progressive draw', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const latest = mockCompactSource([12, 22, 7]);
      const inFlight = jest.spyOn(getCompactRenderController(first), 'isProgressiveDrawInFlight').mockReturnValue(true);
      const onCompactFrameReady = jest.fn();
      const view = render(
        <UPlotChart data={first} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );

      view.rerender(
        <UPlotChart data={second} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );
      view.rerender(
        <UPlotChart data={latest} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );
      expect(setCompactDataMock).not.toHaveBeenCalled();

      inFlight.mockReturnValue(false);
      act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
      await Promise.resolve();

      expect(setCompactDataMock).toHaveBeenCalledTimes(1);
      expect(setCompactDataMock).toHaveBeenCalledWith(latest);
      expect(onCompactFrameReady).toHaveBeenCalledWith(first, config, 100, 100);
      inFlight.mockRestore();
    });

    it('reports when a compact plot draw is complete', async () => {
      const { config } = mockData();
      const data = mockCompactSource([10, 20, 5]);
      const onCompactFrameReady = jest.fn();
      render(
        <UPlotChart data={data} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );

      act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
      await Promise.resolve();
      expect(onCompactFrameReady).toHaveBeenCalledWith(data, config, 100, 100);
    });

    it('keeps only the latest completed compact canvas visible while replacements draw', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const third = mockCompactSource([12, 22, 7]);
      const drawImage = jest.fn();
      const clearRect = jest.fn();
      const getContext = jest
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ clearRect, drawImage } as unknown as CanvasRenderingContext2D);
      const view = render(<UPlotChart data={first} config={config} width={100} height={100} />);
      const plotContainer = screen.getByTestId('uplot-main-div');
      const completedCanvas = document.createElement('canvas');
      completedCanvas.width = 100;
      completedCanvas.height = 100;
      plotContainer.appendChild(completedCanvas);

      view.rerender(<UPlotChart data={second} config={config} width={100} height={100} holdPreviousCompactFrame />);

      expect(drawImage).toHaveBeenCalledWith(completedCanvas, 0, 0);
      expect(plotContainer).toHaveStyle({ visibility: 'hidden' });
      expect(plotContainer.parentElement?.querySelectorAll('canvas')).toHaveLength(2);
      const snapshot = plotContainer.parentElement?.querySelector<HTMLCanvasElement>(
        'canvas[data-compact-frame-snapshot="true"]'
      );
      completedCanvas.width = 240;
      completedCanvas.height = 160;
      jest.spyOn(completedCanvas, 'getBoundingClientRect').mockReturnValue({
        left: 20,
        top: 30,
        width: 120,
        height: 80,
      } as DOMRect);
      jest.spyOn(plotContainer.parentElement!, 'getBoundingClientRect').mockReturnValue({
        left: 5,
        top: 10,
      } as DOMRect);

      const inFlight = jest
        .spyOn(getCompactRenderController(second), 'isProgressiveDrawInFlight')
        .mockReturnValue(true);
      view.rerender(<UPlotChart data={third} config={config} width={100} height={100} holdPreviousCompactFrame />);
      inFlight.mockReturnValue(false);
      act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
      await Promise.resolve();

      expect(clearRect).toHaveBeenCalledWith(0, 0, 100, 100);
      expect(drawImage).toHaveBeenLastCalledWith(completedCanvas, 0, 0);
      expect(snapshot).toMatchObject({ width: 240, height: 160 });
      expect(snapshot).toHaveStyle({ left: '15px', top: '20px', width: '120px', height: '80px' });
      expect(setCompactDataMock).toHaveBeenLastCalledWith(third);

      view.rerender(<UPlotChart data={third} config={config} width={100} height={100} />);
      expect(plotContainer).toHaveStyle({ visibility: 'visible' });
      expect(plotContainer.parentElement?.querySelectorAll('canvas')).toHaveLength(1);
      inFlight.mockRestore();
      getContext.mockRestore();
    });

    it('keeps the retained canvas when the host rejects a completed source', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const latest = mockCompactSource([12, 22, 7]);
      const drawImage = jest.fn();
      const clearRect = jest.fn();
      const getContext = jest
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ clearRect, drawImage } as unknown as CanvasRenderingContext2D);
      const onCompactFrameReady = jest.fn(() => false);
      const view = render(
        <UPlotChart data={first} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );
      const plotContainer = screen.getByTestId('uplot-main-div');
      const completedCanvas = document.createElement('canvas');
      completedCanvas.width = 100;
      completedCanvas.height = 100;
      plotContainer.appendChild(completedCanvas);
      view.rerender(
        <UPlotChart
          data={second}
          config={config}
          width={100}
          height={100}
          holdPreviousCompactFrame
          onCompactFrameReady={onCompactFrameReady}
        />
      );
      const priorSnapshotDraws = drawImage.mock.calls.length;
      const priorSnapshotClears = clearRect.mock.calls.length;
      const inFlight = jest
        .spyOn(getCompactRenderController(second), 'isProgressiveDrawInFlight')
        .mockReturnValue(true);

      view.rerender(
        <UPlotChart
          data={latest}
          config={config}
          width={100}
          height={100}
          holdPreviousCompactFrame
          onCompactFrameReady={onCompactFrameReady}
        />
      );
      inFlight.mockReturnValue(false);
      act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
      await Promise.resolve();

      expect(clearRect).toHaveBeenCalledTimes(priorSnapshotClears);
      expect(drawImage).toHaveBeenCalledTimes(priorSnapshotDraws);
      expect(setCompactDataMock).toHaveBeenLastCalledWith(latest);
      inFlight.mockRestore();
      getContext.mockRestore();
    });

    it('tracks the resized plot geometry while retaining an older completed frame', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const drawImage = jest.fn();
      const clearRect = jest.fn();
      const getContext = jest
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ clearRect, drawImage } as unknown as CanvasRenderingContext2D);
      const view = render(<UPlotChart data={first} config={config} width={100} height={100} />);
      const plotContainer = screen.getByTestId('uplot-main-div');
      const completedCanvas = document.createElement('canvas');
      completedCanvas.width = 100;
      completedCanvas.height = 100;
      plotContainer.appendChild(completedCanvas);
      view.rerender(<UPlotChart data={second} config={config} width={100} height={100} holdPreviousCompactFrame />);
      const snapshot = plotContainer.parentElement?.querySelector<HTMLCanvasElement>(
        'canvas[data-compact-frame-snapshot="true"]'
      );
      const priorSnapshotDraws = drawImage.mock.calls.length;
      const priorSnapshotClears = clearRect.mock.calls.length;
      let sourceRect = { left: 10, top: 15, width: 100, height: 100 } as DOMRect;
      jest.spyOn(completedCanvas, 'getBoundingClientRect').mockImplementation(() => sourceRect);
      jest.spyOn(plotContainer.parentElement!, 'getBoundingClientRect').mockReturnValue({
        left: 10,
        top: 15,
      } as DOMRect);
      compactSetSizeEffect = () => {
        queueMicrotask(() => {
          sourceRect = { left: 30, top: 45, width: 200, height: 150 } as DOMRect;
        });
      };
      const inFlight = jest
        .spyOn(getCompactRenderController(second), 'isProgressiveDrawInFlight')
        .mockReturnValue(true);

      view.rerender(<UPlotChart data={second} config={config} width={200} height={150} holdPreviousCompactFrame />);
      inFlight.mockReturnValue(false);
      act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
      await Promise.resolve();
      await Promise.resolve();

      expect(snapshot).toHaveStyle({ left: '20px', top: '30px', width: '200px', height: '150px' });
      expect(snapshot).toMatchObject({ width: 100, height: 100 });
      expect(drawImage).toHaveBeenCalledTimes(priorSnapshotDraws);
      expect(clearRect).toHaveBeenCalledTimes(priorSnapshotClears);
      expect(setSizeMock).toHaveBeenCalledWith({ width: 200, height: 150 });
      inFlight.mockRestore();
      getContext.mockRestore();
    });

    it('resizes the existing plot without presenting an old-size progressive draw', async () => {
      const { config } = mockData();
      const data = mockCompactSource([10, 20, 5]);
      const onCompactFrameReady = jest.fn();
      const inFlight = jest.spyOn(getCompactRenderController(data), 'isProgressiveDrawInFlight').mockReturnValue(true);
      const view = render(
        <UPlotChart data={data} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );

      view.rerender(
        <UPlotChart data={data} config={config} width={200} height={200} onCompactFrameReady={onCompactFrameReady} />
      );
      inFlight.mockReturnValue(false);
      act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
      await Promise.resolve();

      expect(onCompactFrameReady).not.toHaveBeenCalled();
      expect(setSizeMock).toHaveBeenCalledWith({ width: 200, height: 200 });
      expect(destroyMock).not.toHaveBeenCalled();
      expect(uPlot.compact).toHaveBeenCalledTimes(1);
      inFlight.mockRestore();
    });

    it('applies the latest source and size after an in-flight draw without remounting', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const latest = mockCompactSource([12, 22, 7]);
      const onCompactFrameReady = jest.fn();
      const inFlight = jest.spyOn(getCompactRenderController(first), 'isProgressiveDrawInFlight').mockReturnValue(true);
      const view = render(
        <UPlotChart data={first} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );

      view.rerender(
        <UPlotChart data={latest} config={config} width={200} height={150} onCompactFrameReady={onCompactFrameReady} />
      );
      inFlight.mockReturnValue(false);
      act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
      await Promise.resolve();

      expect(onCompactFrameReady).not.toHaveBeenCalled();
      expect(setCompactDataMock).toHaveBeenCalledWith(latest);
      expect(setSizeMock).toHaveBeenCalledWith({ width: 200, height: 150 });
      expect(compactPlot.compactSource).toBe(latest);
      expect(destroyMock).not.toHaveBeenCalled();
      expect(uPlot.compact).toHaveBeenCalledTimes(1);
      inFlight.mockRestore();
    });

    it('updates compact data before reporting a simultaneous size draw', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const onCompactFrameReady = jest.fn();
      const view = render(
        <UPlotChart data={first} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );
      drawCompactOnSetSize = true;

      view.rerender(
        <UPlotChart data={second} config={config} width={200} height={200} onCompactFrameReady={onCompactFrameReady} />
      );
      await Promise.resolve();

      expect(setCompactDataMock).toHaveBeenCalledWith(second);
      expect(onCompactFrameReady).toHaveBeenCalledWith(second, config, 200, 200);
    });
  });

  describe('config update', () => {
    it('reinitializes a compact plot when its resolved configuration changes', () => {
      const { config } = mockData();
      const data = mockCompactSource([10, 20, 5]);
      const view = render(<UPlotChart data={data} config={config} width={100} height={100} />);
      const nextConfig = new UPlotConfigBuilder();
      nextConfig.addSeries({} as SeriesProps);

      view.rerender(<UPlotChart data={data} config={nextConfig} width={100} height={100} />);

      expect(destroyMock).toHaveBeenCalledTimes(1);
      expect(uPlot.compact).toHaveBeenCalledTimes(2);
      expect(setCompactDataMock).not.toHaveBeenCalled();
    });

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

    it('does not redraw when fractional dimensions floor to the current plot size', () => {
      const { config } = mockData();
      const data = mockCompactSource([10, 20, 5]);
      const { rerender } = render(<UPlotChart data={data} config={config} width={100} height={100} />);

      rerender(<UPlotChart data={data} config={config} width={100.5} height={100.75} />);

      expect(setSizeMock).not.toHaveBeenCalled();
      expect(setCompactDataMock).not.toHaveBeenCalled();
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
    styles: [{ stroke: '#f00', cursorStroke: '#ff000080' }],
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
