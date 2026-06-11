import uPlot from 'uplot';

describe('uPlot compact X host', () => {
  test('keeps X values in the compact source and preserves the normal chart lifecycle', () => {
    const target = document.createElement('div');
    const first = createSource([1, 2, 3]);
    const controller = createController();
    const plot = uPlot.compact(createOptions(), first, controller, target);

    expect(plot.compactSource).toBe(first);
    expect(plot.series).toHaveLength(1);
    expect(plot.data).toEqual([[]]);
    expect(plot.getX?.(2)).toBe(3000);
    expect(plot.valToIdx(2100)).toBe(1);
    expect(target.contains(plot.root)).toBe(true);

    const second = createSource([4, 5]);
    plot.setCompactData?.(second);
    expect(plot.compactSource).toBe(second);
    expect(plot.getValue?.(1, 1)).toBe(5);
    expect(controller.replaceSource).toHaveBeenCalledWith(first, second);

    plot.destroy();
    expect(controller.destroy).toHaveBeenCalledWith(second);
    expect(plot.compactSource).toBeNull();
    expect(target.contains(plot.root)).toBe(false);
  });

  test('rejects legacy data replacement on a compact plot', () => {
    expect(() => uPlot.compact(createOptions(), createSource([1]), null, document.createElement('div'))).toThrow(
      'render controller'
    );
  });

  test('routes scale, draw, and virtual series state through the controller without legacy series', async () => {
    const source = createSource([1, 2, 3]);
    const controller = createController();
    const plot = uPlot.compact(createOptions(true), source, controller, document.createElement('div'));
    await flushCommit();

    expect(plot.series).toHaveLength(1);
    expect(plot.data).toEqual([[]]);
    expect(controller.extent).toHaveBeenCalledWith(plot, 'y', 0, 2);
    expect(controller.draw).toHaveBeenCalledWith(plot, 0, 2);

    plot.setSeries(1, { show: false });
    await flushCommit();
    expect(controller.setSeries).toHaveBeenCalledWith(0, { show: false });
    expect(() => plot.setSeries(0, { show: false })).toThrow('out of range');
    plot.destroy();
  });

  test('clears the compact point marker when a programmatic cursor update has no local point', async () => {
    const target = document.createElement('div');
    const controller = createController();
    let pointVisible = true;
    controller.updateCursor.mockImplementation((_plot, index) =>
      index != null && pointVisible
        ? {
            hasPoint: true,
            seriesIndex: 0,
            dataIndex: index === 2 ? 1 : index + 1,
            distance: 0,
            left: 10,
            top: 20,
            size: 6,
            fill: '#f00',
            stroke: '#000',
          }
        : {
            hasPoint: false,
            seriesIndex: -1,
            dataIndex: -1,
            distance: Number.POSITIVE_INFINITY,
            left: -10,
            top: -10,
            size: 0,
            fill: '',
            stroke: '',
          }
    );
    const plot = uPlot.compact(
      {
        ...createOptions(true),
        cursor: { show: true, points: { one: true }, focus: { prox: 30 } },
      },
      createSource([1, 2, 3]),
      controller,
      target
    );
    await flushCommit();

    Reflect.set(plot.cursor, 'event', new MouseEvent('mousemove'));
    plot.setCursor({ left: 100, top: 50 }, true);
    const marker = target.querySelector<HTMLElement>('.u-cursor-pt');
    expect(controller.updateCursor).toHaveBeenLastCalledWith(plot, expect.any(Number), 50, 'programmatic');
    expect(plot.cursor.idx).toBe(1);
    expect(plot.compactCursor?.dataIndex).toBe(2);
    expect(marker?.style.transform).not.toContain('-10px');

    pointVisible = false;
    plot.setCursor({ left: 120, top: 50 }, true);
    expect(plot.cursor.idx).toBe(1);
    expect(plot.compactCursor).toMatchObject({ hasPoint: false, seriesIndex: -1 });
    expect(marker?.style.transform).toContain('-10px');
    plot.destroy();
  });

  test('passes native synchronization origin to receiving compact plots', async () => {
    const sourceController = createController();
    const receiverController = createController();
    const syncKey = `compact-test-${Math.random()}`;
    const options = {
      ...createOptions(true),
      cursor: { show: true, sync: { key: syncKey, scales: ['x', null] as [string, null] } },
    };
    const sourcePlot = uPlot.compact(options, createSource([1, 2, 3]), sourceController, document.createElement('div'));
    const receiverPlot = uPlot.compact(
      options,
      createSource([1, 2, 3]),
      receiverController,
      document.createElement('div')
    );
    await flushCommit();

    sourcePlot.setCursor({ left: 100, top: 50 }, true, true);
    expect(sourceController.updateCursor).toHaveBeenLastCalledWith(sourcePlot, expect.any(Number), 50, 'programmatic');
    expect(receiverController.updateCursor).toHaveBeenLastCalledWith(
      receiverPlot,
      expect.any(Number),
      expect.any(Number),
      'native-sync'
    );
    expect(sourcePlot.compactCursorOrigin).toBe('programmatic');
    expect(receiverPlot.compactCursorOrigin).toBe('native-sync');

    Reflect.set(receiverPlot.cursor, 'event', new MouseEvent('mousemove'));
    receiverPlot.setCursor({ left: 120, top: 40 }, true, false, 'native-sync');
    expect(receiverController.updateCursor).toHaveBeenLastCalledWith(
      receiverPlot,
      expect.any(Number),
      40,
      'native-sync'
    );

    receiverController.updateCursor.mockClear();
    receiverPlot.setCompactData?.(createSource([2, 3, 4]));
    await flushCommit();
    expect(receiverController.updateCursor).toHaveBeenLastCalledWith(
      receiverPlot,
      expect.any(Number),
      expect.any(Number),
      'native-sync'
    );

    sourcePlot.destroy();
    receiverPlot.destroy();
  });

  test('fires compact draw hooks only after a progressive draw completes', async () => {
    let finishDraw: (completed: boolean) => void = () => {};
    const controller = createController();
    controller.draw.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishDraw = resolve;
      })
    );
    const draw = jest.fn();
    const drawSeries = jest.fn();
    const plot = uPlot.compact(
      {
        ...createOptions(true),
        hooks: { draw: [draw], drawSeries: [drawSeries] },
      },
      createSource([1, 2, 3]),
      controller,
      document.createElement('div')
    );
    await flushCommit();

    expect(controller.draw).toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
    expect(drawSeries).not.toHaveBeenCalled();

    finishDraw(true);
    await Promise.resolve();

    expect(drawSeries.mock.calls[0].slice(0, 2)).toEqual([plot, -1]);
    expect(draw.mock.calls[0][0]).toBe(plot);
    plot.destroy();
  });

  test('does not fire compact draw hooks for a cancelled progressive draw', async () => {
    let finishDraw: (completed: boolean) => void = () => {};
    const controller = createController();
    controller.draw.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishDraw = resolve;
      })
    );
    const draw = jest.fn();
    const drawSeries = jest.fn();
    const plot = uPlot.compact(
      {
        ...createOptions(true),
        hooks: { draw: [draw], drawSeries: [drawSeries] },
      },
      createSource([1, 2, 3]),
      controller,
      document.createElement('div')
    );
    await flushCommit();

    finishDraw(false);
    await Promise.resolve();

    expect(drawSeries).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
    plot.destroy();
  });

  test('rebuilds and releases ordinary legacy paths when retainPaths is false', async () => {
    const transientPath = jest.fn(() => ({}));
    const retainedPath = jest.fn(() => ({}));
    const target = document.createElement('div');
    const plot = new uPlot(
      {
        width: 300,
        height: 200,
        series: [
          {},
          { scale: 'y', paths: transientPath, retainPaths: false } as uPlot.Series,
          { scale: 'y', paths: retainedPath } as uPlot.Series,
        ],
        axes: [],
        scales: { x: { time: true }, y: { auto: true } },
        legend: { show: false },
        cursor: { show: false },
      },
      [
        [1000, 2000],
        [1, 2],
        [2, 3],
      ],
      target
    );
    await flushCommit();

    const transientCalls = transientPath.mock.calls.length;
    const retainedCalls = retainedPath.mock.calls.length;
    plot.redraw(false);
    await flushCommit();

    expect(transientPath).toHaveBeenCalledTimes(transientCalls + 1);
    expect(retainedPath).toHaveBeenCalledTimes(retainedCalls);
    plot.destroy();
  });
});

function createOptions(withYScale = false): uPlot.Options {
  return {
    width: 300,
    height: 200,
    series: [{ value: () => '' }],
    axes: [],
    scales: { x: { time: true }, ...(withYScale ? { y: { auto: true } } : {}) },
    legend: { show: false },
    cursor: { show: false },
  };
}

function createController(): jest.Mocked<uPlot.CompactRenderController> {
  return {
    replaceSource: jest.fn(),
    destroy: jest.fn(),
    extent: jest.fn<[number | null, number | null], [uPlot, string, number, number]>(() => [0, 10]),
    draw: jest.fn(),
    setSeries: jest.fn<boolean, [number | null, { show?: boolean; focus?: boolean }]>(() => true),
    updateCursor: jest.fn<uPlot.CompactCursorState | null, [uPlot, number | null, number, uPlot.CompactCursorOrigin]>(
      () => null
    ),
  };
}

async function flushCommit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createSource(values: number[]): uPlot.CompactPlotSource {
  const buffer = new Float64Array(values).buffer;
  return {
    kind: 'compact-v1',
    buffer,
    pointCount: values.length,
    seriesCount: 1,
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
