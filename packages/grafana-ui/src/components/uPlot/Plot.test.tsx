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

    it('reports when a compact plot draw is complete', async () => {
      const { config } = mockData();
      const data = mockCompactSource([10, 20, 5]);
      const onCompactFrameReady = jest.fn();
      render(
        <UPlotChart data={data} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );

      await completeCompactDraw();
      expect(onCompactFrameReady).toHaveBeenCalledWith(data, config, 100, 100);
    });

    it('coalesces source revisions behind an active progressive draw', async () => {
      const { config } = mockData();
      const sources = [mockCompactSource([10, 20, 5]), mockCompactSource([11, 21, 6]), mockCompactSource([12, 22, 7])];
      const onCompactFrameReady = jest.fn();
      const inFlight = jest
        .spyOn(getCompactRenderController(sources[0]), 'isProgressiveDrawInFlight')
        .mockReturnValue(true);
      const chart = (sourceIndex: number) => (
        <UPlotChart
          data={sources[sourceIndex]}
          config={config}
          width={100}
          height={100}
          onCompactFrameReady={onCompactFrameReady}
        />
      );
      const view = render(chart(0));

      view.rerender(chart(1));
      view.rerender(chart(2));
      expect(setCompactDataMock).not.toHaveBeenCalled();

      inFlight.mockReturnValue(false);
      await completeCompactDraw();

      expect(setCompactDataMock).toHaveBeenCalledTimes(1);
      expect(setCompactDataMock).toHaveBeenCalledWith(sources[2]);
      expect(setSizeMock).not.toHaveBeenCalled();
      expect(onCompactFrameReady).toHaveBeenCalledWith(sources[0], config, 100, 100);
      expect(uPlot.compact).toHaveBeenCalledTimes(1);
      inFlight.mockRestore();
    });

    it.each([
      { name: 'resizes', sourceIndex: 0, width: 200, height: 200, updatesSource: false },
      { name: 'applies source and size together', sourceIndex: 2, width: 200, height: 150, updatesSource: true },
    ])(
      '$name without remounting behind an active progressive draw',
      async ({ sourceIndex, width, height, updatesSource }) => {
        const { config } = mockData();
        const sources = [
          mockCompactSource([10, 20, 5]),
          mockCompactSource([11, 21, 6]),
          mockCompactSource([12, 22, 7]),
        ];
        const onCompactFrameReady = jest.fn();
        const inFlight = jest
          .spyOn(getCompactRenderController(sources[0]), 'isProgressiveDrawInFlight')
          .mockReturnValue(true);
        const chart = (sourceIndex: number, width: number, height: number) => (
          <UPlotChart
            data={sources[sourceIndex]}
            config={config}
            width={width}
            height={height}
            onCompactFrameReady={onCompactFrameReady}
          />
        );
        const view = render(chart(0, 100, 100));

        view.rerender(chart(sourceIndex, width, height));
        expect(setCompactDataMock).not.toHaveBeenCalled();

        inFlight.mockReturnValue(false);
        await completeCompactDraw();

        if (updatesSource) {
          expect(setCompactDataMock).toHaveBeenCalledTimes(1);
          expect(setCompactDataMock).toHaveBeenCalledWith(sources[sourceIndex]);
        } else {
          expect(setCompactDataMock).not.toHaveBeenCalled();
        }
        expect(setSizeMock).toHaveBeenCalledWith({ width, height });
        expect(onCompactFrameReady).not.toHaveBeenCalled();
        expect(uPlot.compact).toHaveBeenCalledTimes(1);
        inFlight.mockRestore();
      }
    );

    it('keeps only the latest completed compact canvas visible while replacements draw', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const third = mockCompactSource([12, 22, 7]);
      const view = render(<UPlotChart data={first} config={config} width={100} height={100} />);
      const canvas = installCompletedCanvas();

      view.rerender(<UPlotChart data={second} config={config} width={100} height={100} holdPreviousCompactFrame />);

      expect(canvas.drawImage).toHaveBeenCalledWith(canvas.live, 0, 0);
      expectSingleVisibleCanvas(canvas.plotContainer, true);
      const retained = canvas.retained();

      const inFlight = jest
        .spyOn(getCompactRenderController(second), 'isProgressiveDrawInFlight')
        .mockReturnValue(true);
      view.rerender(<UPlotChart data={third} config={config} width={100} height={100} holdPreviousCompactFrame />);
      inFlight.mockReturnValue(false);
      await completeCompactDraw();

      expectSingleVisibleCanvas(canvas.plotContainer, true);
      expect(canvas.retained()).toBe(retained);
      expect(setCompactDataMock).toHaveBeenLastCalledWith(third);

      view.rerender(<UPlotChart data={third} config={config} width={100} height={100} />);
      expectSingleVisibleCanvas(canvas.plotContainer, false);
      inFlight.mockRestore();
      canvas.restore();
    });

    it('keeps the retained canvas when the host rejects a completed source', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const latest = mockCompactSource([12, 22, 7]);
      const onCompactFrameReady = jest.fn(() => false);
      const view = render(
        <UPlotChart data={first} config={config} width={100} height={100} onCompactFrameReady={onCompactFrameReady} />
      );
      const canvas = installCompletedCanvas();
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
      const retained = canvas.retained();
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
      await completeCompactDraw();

      expect(canvas.retained()).toBe(retained);
      expectSingleVisibleCanvas(canvas.plotContainer, true);
      expect(setCompactDataMock).toHaveBeenLastCalledWith(latest);
      inFlight.mockRestore();
      canvas.restore();
    });

    it('tracks the resized plot geometry while retaining an older completed frame', async () => {
      const { config } = mockData();
      const first = mockCompactSource([10, 20, 5]);
      const second = mockCompactSource([11, 21, 6]);
      const view = render(<UPlotChart data={first} config={config} width={100} height={100} />);
      const canvas = installCompletedCanvas();
      view.rerender(<UPlotChart data={second} config={config} width={100} height={100} holdPreviousCompactFrame />);
      const snapshot = canvas.retained();
      let sourceRect = { left: 10, top: 15, width: 100, height: 100 } as DOMRect;
      jest.spyOn(canvas.live, 'getBoundingClientRect').mockImplementation(() => sourceRect);
      jest.spyOn(canvas.plotContainer.parentElement!, 'getBoundingClientRect').mockReturnValue({
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
      await completeCompactDraw();
      await Promise.resolve();

      expect(snapshot).toHaveStyle({ left: '20px', top: '30px', width: '200px', height: '150px' });
      expect(snapshot).toMatchObject({ width: 100, height: 100 });
      expect(canvas.retained()).toBe(snapshot);
      expectSingleVisibleCanvas(canvas.plotContainer, true);
      expect(setSizeMock).toHaveBeenCalledWith({ width: 200, height: 150 });
      inFlight.mockRestore();
      canvas.restore();
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

async function completeCompactDraw() {
  act(() => compactDrawHooks.forEach((hook) => hook(compactPlot)));
  await Promise.resolve();
}

function installCompletedCanvas() {
  const drawImage = jest.fn();
  const clearRect = jest.fn();
  const getContext = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ clearRect, drawImage } as unknown as CanvasRenderingContext2D);
  const plotContainer = screen.getByTestId('uplot-main-div');
  const live = document.createElement('canvas');
  live.width = 100;
  live.height = 100;
  plotContainer.appendChild(live);

  return {
    drawImage,
    live,
    plotContainer,
    retained: () =>
      plotContainer.parentElement?.querySelector<HTMLCanvasElement>('canvas[data-compact-frame-snapshot="true"]'),
    restore: () => getContext.mockRestore(),
  };
}

function expectSingleVisibleCanvas(plotContainer: HTMLElement, retained: boolean) {
  expect(plotContainer).toHaveStyle({ visibility: retained ? 'hidden' : 'visible' });
  expect(plotContainer.parentElement?.querySelectorAll('canvas')).toHaveLength(retained ? 2 : 1);
  const retainedCanvas = plotContainer.parentElement?.querySelector('canvas[data-compact-frame-snapshot="true"]');
  if (retained) {
    expect(retainedCanvas).toBeInstanceOf(HTMLCanvasElement);
  } else {
    expect(retainedCanvas).toBeNull();
  }
}

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
