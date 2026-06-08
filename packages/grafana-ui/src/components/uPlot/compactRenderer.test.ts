import uPlot from 'uplot';

import { ScaleDistribution } from '@grafana/schema';

import {
  CompactRenderController,
  CompactRenderSource,
  CompactSeriesFlag,
  CompactStyleRecord,
  getCompactRenderController,
} from './compactRenderer';

describe('CompactRenderController', () => {
  test('draws source-native lines, steps, points, bars, splines, and gaps without dense arrays', () => {
    const source = createSource(
      [
        [1, 2, null, 4],
        [1, 2, 3, 4],
        [1, undefined, 3, 4],
        [1, 2, 3, 4],
        [1, 2, 3, 4],
      ],
      [
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine,
        CompactSeriesFlag.StepAfter | CompactSeriesFlag.DrawLine,
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Points,
        CompactSeriesFlag.Bars,
        CompactSeriesFlag.Spline | CompactSeriesFlag.DrawLine,
      ]
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 3);

    expect(context.moveTo).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.arc).toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.quadraticCurveTo).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    expect(source.scan).toHaveBeenCalled();
    expect(source.buffer).toBe(source.samples.buffer);
  });

  test('computes stacked extents with visible-window scratch and updates typed visibility', () => {
    const source = createSource(
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      [
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
        CompactSeriesFlag.Bars | CompactSeriesFlag.Stack,
      ],
      1
    );
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.extent(plot, 'y', 0, 2)).toEqual([0, 9]);
    controller.draw(plot, 1, 2);
    expect(source.scan).toHaveBeenCalledWith(0, 0, 2, expect.any(Function));
    expect(source.scan).toHaveBeenCalledWith(1, 0, 2, expect.any(Function));

    expect(controller.setSeries(1, { show: false })).toBe(true);
    expect(source.columns.visibility).toEqual(new Uint8Array([1, 0]));
    expect(controller.extent(plot, 'y', 0, 2)).toEqual([0, 3]);
  });

  test('releases superseded response storage after transferring controller ownership', () => {
    const first = createSource([[1, 2]], [CompactSeriesFlag.Linear]);
    const second = createSource([[3, 4]], [CompactSeriesFlag.Linear]);
    const controller = new CompactRenderController(first);

    controller.replaceSource(first, second);
    expect(getCompactRenderController(second)).toBe(controller);
    expect(first.buffer.byteLength).toBe(0);
    expect(second.buffer.byteLength).toBeGreaterThan(0);
    expect(() => controller.replaceSource(first, second)).toThrow('ownership mismatch');
    expect(() => controller.replaceSource(second, createSource([[5, 6]], [CompactSeriesFlag.Stack], 1))).toThrow(
      'stack topology'
    );

    controller.destroy(second);
  });

  test('keeps shared response storage alive when replacing a source view', () => {
    const first = createSource([[1, 2]], [CompactSeriesFlag.Linear]);
    const release = jest.fn(first.release);
    first.release = release;
    const second: TestSource = {
      ...first,
      columns: {
        ...first.columns,
        visibility: new Uint8Array(first.columns.visibility),
      },
      visibilityState: { overrides: new Map() },
    };
    const controller = new CompactRenderController(first);

    controller.replaceSource(first, second);

    expect(release).not.toHaveBeenCalled();
    expect(second.buffer.byteLength).toBeGreaterThan(0);
    expect(getCompactRenderController(second)).toBe(controller);
    controller.destroy(second);
  });

  test.each(['visibility change', 'source replacement', 'destruction'] as const)(
    'cancels a progressive line draw on %s',
    async (action) => {
      const callbacks = new Map<ReturnType<typeof window.setTimeout>, TimerHandler>();
      let nextTimer = 0;
      const setTimeout = jest.spyOn(window, 'setTimeout').mockImplementation((callback) => {
        const timer = ++nextTimer as unknown as ReturnType<typeof window.setTimeout>;
        callbacks.set(timer, callback);
        return timer;
      });
      const clearTimeout = jest.spyOn(window, 'clearTimeout').mockImplementation((timer) => {
        callbacks.delete(timer as ReturnType<typeof window.setTimeout>);
      });
      try {
        const source = createVirtualSource(1000, 1000);
        const controller = new CompactRenderController(source);
        const { plot } = createPlot();

        const completed = controller.draw(plot, 0, 999);

        expect(completed).toBeInstanceOf(Promise);
        expect(source.scan.mock.calls.length).toBeGreaterThan(0);
        expect(source.scan.mock.calls.length).toBeLessThan(source.seriesCount);
        expect(callbacks.size).toBe(1);

        if (action === 'visibility change') {
          controller.setSeries(0, { show: false });
        } else if (action === 'source replacement') {
          controller.replaceSource(source, createVirtualSource(1000, 1000));
        } else {
          controller.destroy(source);
        }

        await expect(completed).resolves.toBe(false);
        expect(callbacks.size).toBe(0);
      } finally {
        setTimeout.mockRestore();
        clearTimeout.mockRestore();
      }
    }
  );

  test('preserves visibility only when the replacement has the same series identity', () => {
    const first = createSource(
      [
        [1, 2],
        [3, 4],
      ],
      [CompactSeriesFlag.Linear, CompactSeriesFlag.Linear]
    );
    const reordered = createSource(
      [
        [5, 6],
        [7, 8],
      ],
      [CompactSeriesFlag.Linear, CompactSeriesFlag.Linear]
    );
    const identities = ['requests', 'errors'];
    first.seriesIdentityAt = (index) => identities[index];
    first.seriesIdentityHashAt = (index) => index + 1;
    reordered.seriesIdentityAt = (index) => identities[1 - index];
    reordered.seriesIdentityHashAt = (index) => 2 - index;
    const controller = new CompactRenderController(first);

    controller.setSeries(null, { show: false });
    controller.setSeries(0, { show: true });
    controller.replaceSource(first, reordered);
    expect(reordered.columns.visibility).toEqual(new Uint8Array([0, 1]));

    controller.destroy(reordered);
    reordered.columns.visibility.fill(1);
    new CompactRenderController(reordered);
    expect(reordered.columns.visibility).toEqual(new Uint8Array([0, 1]));
  });

  test('resolves cursor focus directly from source values', () => {
    const source = createSource(
      [
        [1, null, 3],
        [10, 11, 12],
      ],
      [CompactSeriesFlag.Linear, CompactSeriesFlag.Linear]
    );
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    const cursor = controller.updateCursor(plot, 1, 10);
    expect(cursor).toMatchObject({ seriesIndex: 1, dataIndex: 1, top: 11 });

    controller.setSeries(1, { show: false });
    expect(controller.updateCursor(plot, 1, 2)).toBeNull();
  });

  test('resolves the nearest series for a local multi-series tooltip cursor', () => {
    const source = createSource(
      [
        [1, 2, 3],
        [10, 11, 12],
      ],
      [CompactSeriesFlag.Linear, CompactSeriesFlag.Linear],
      0,
      'series',
      'multi'
    );
    source.yAt = jest.fn(source.yAt);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 10)).toMatchObject({ seriesIndex: 1, dataIndex: 1, top: 11 });
    expect(source.yAt).toHaveBeenCalledTimes(2);
  });

  test('does not scan series for a synchronized cursor update', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Linear]);
    source.yAt = jest.fn(source.yAt);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();
    Reflect.set(plot, 'cursor', { event: null });

    expect(controller.updateCursor(plot, 1, 10)).toMatchObject({ seriesIndex: -1, dataIndex: 1 });
    expect(source.yAt).not.toHaveBeenCalled();
  });

  test('does not redraw the complete plot when compact focus changes', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine]);
    const controller = new CompactRenderController(source);

    expect(controller.setSeries(0, { focus: true })).toBe(false);
    expect(controller.setSeries(null, { focus: true })).toBe(false);

    Reflect.set(source, 'focusAlpha', 0.3);
    expect(controller.setSeries(0, { focus: true })).toBe(false);
  });

  test('draws and clears a focused-series overlay without rebuilding the complete plot', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine]);
    source.focusOverlayColor = 'rgba(0, 0, 0, 0.5)';
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    const parent = document.createElement('div');
    const mainCanvas = document.createElement('canvas');
    const over = document.createElement('div');
    parent.append(mainCanvas, over);
    Object.defineProperty(context, 'canvas', { value: mainCanvas });
    Reflect.set(plot, 'over', over);
    const overlayContext = {
      ...context,
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      stroke: jest.fn(),
    } as unknown as jest.Mocked<CanvasRenderingContext2D>;
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      Object.defineProperty(overlayContext, 'canvas', { value: this, configurable: true });
      return overlayContext;
    });

    try {
      controller.draw(plot, 0, 2);
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();

      source.scan.mockClear();
      expect(controller.setSeries(0, { focus: true })).toBe(false);
      expect(parent.querySelectorAll('.u-compact-focus-overlay')).toHaveLength(1);
      expect(overlayContext.fillRect).toHaveBeenCalledWith(0, 0, 100, 100);
      expect(overlayContext.stroke).toHaveBeenCalledTimes(1);
      expect(source.scan).toHaveBeenCalledTimes(1);

      controller.setSeries(null, { focus: true });
      expect(overlayContext.clearRect).toHaveBeenCalled();
      controller.destroy(source);
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();
    } finally {
      getContext.mockRestore();
    }
  });

  test('draws regular linear series directly from response storage', () => {
    const source = createSource([[2, 4, 8]], [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine]);
    source.prepareBufferScan = jest.fn((_series, from, target) => {
      Object.assign(target, {
        axisStart: 10,
        axisStep: 5,
        valuesByteOffset: 0,
        presenceByteOffset: 0,
        presenceByteLength: 0,
        packedIndex: from,
        valueMultiplier: 1,
        missingValue: null,
      });
      return true;
    });
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    plot.scales.x.min = 10;
    plot.scales.x.max = 20;
    plot.scales.y.min = 0;
    plot.scales.y.max = 10;
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? (value - 10) * 2 : 100 - value * 10);

    controller.draw(plot, 0, 2);

    expect(source.prepareBufferScan).toHaveBeenCalledWith(0, 0, expect.any(Object));
    expect(source.scan).not.toHaveBeenCalled();
    expect(context.moveTo).toHaveBeenCalledWith(0, 80);
    expect(context.lineTo.mock.calls).toEqual([
      [10, 60],
      [20, 20],
    ]);
  });

  test('reads packed values and disconnects source gaps on the direct path', () => {
    const buffer = new ArrayBuffer(32);
    new Uint8Array(buffer)[0] = 0b0000_0101;
    const values = new DataView(buffer);
    values.setFloat64(8, 2, true);
    values.setFloat64(16, 8, true);
    const source = createSource([[2, null, 8]], [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine]);
    Reflect.set(source, 'buffer', buffer);
    source.prepareBufferScan = (_series, from, target) => {
      Object.assign(target, {
        axisStart: 10,
        axisStep: 5,
        valuesByteOffset: 8,
        presenceByteOffset: 0,
        presenceByteLength: 1,
        packedIndex: from === 0 ? 0 : 1,
        valueMultiplier: 1,
        missingValue: null,
      });
      return true;
    };
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    plot.scales.x.min = 10;
    plot.scales.x.max = 20;
    plot.scales.y.min = 0;
    plot.scales.y.max = 10;
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? (value - 10) * 2 : 100 - value * 10);

    controller.draw(plot, 0, 2);

    expect(source.scan).not.toHaveBeenCalled();
    expect(context.moveTo.mock.calls).toEqual([
      [0, 80],
      [20, 20],
    ]);
    expect(context.lineTo).not.toHaveBeenCalled();
  });

  test('draws points-only series without connecting lines', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Points]);
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 2);

    expect(context.arc).toHaveBeenCalledTimes(3);
    expect(context.lineTo).not.toHaveBeenCalled();
  });

  test('decimates dense linear lines while preserving extrema and source ownership', () => {
    const values = Array.from({ length: 500 }, (_, index) => index);
    values[251] = 1_000;
    values[252] = -100;
    const source = createSource([values], [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine]);
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value / 5 : value);
    plot.posToVal = (value, scaleKey) => (scaleKey === 'x' ? value * 5 : value);

    controller.draw(plot, 0, values.length - 1);

    expect(source.scan).toHaveBeenCalledWith(0, 0, values.length - 1, expect.any(Function));
    const bucket = context.lineTo.mock.calls.filter(([x]) => x === 50);
    expect(bucket).toEqual(
      expect.arrayContaining([
        [50, 1_000],
        [50, -100],
      ])
    );
    expect(bucket.findIndex(([, y]) => y === 1_000)).toBeLessThan(bucket.findIndex(([, y]) => y === -100));
    expect(source.buffer).toBe(source.samples.buffer);
  });

  test('fills gap-separated regions even when the line stroke is disabled', () => {
    const source = createSource(
      [[1, 2, null, 4]],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      { stroke: '#f00', fill: '#fcc', areaFill: '#ff000040', lineWidth: 0 }
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 3);

    expect(context.fill).toHaveBeenCalled();
    expect(context.moveTo).toHaveBeenCalledWith(0, 0);
    expect(context.moveTo).toHaveBeenCalledWith(3, 0);
    expect(context.stroke).not.toHaveBeenCalled();
  });

  test('applies compact dash and cap semantics without changing point fill', () => {
    const source = createSource(
      [[1, 2]],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Points],
      0,
      'series',
      'single',
      {
        stroke: '#f00',
        fill: '#0f0',
        areaFill: '#f004',
        lineWidth: 4,
        lineDash: [2, 5],
        lineCap: 'round',
      }
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    const fillStyles: Array<string | CanvasGradient | CanvasPattern> = [];
    context.fill.mockImplementation(() => fillStyles.push(context.fillStyle));

    controller.draw(plot, 0, 1);

    expect(context.setLineDash).toHaveBeenCalledWith([2, 5]);
    expect(context.setLineDash).toHaveBeenLastCalledWith([]);
    expect(context.lineCap).toBe('butt');
    expect(context.lineWidth).toBe(2.2 * uPlot.pxRatio);
    expect(fillStyles).toContain('#f004');
    expect(fillStyles).toContain('#0f0');
  });

  test('clips dashed source gaps while keeping one continuous stroke path', () => {
    const source = createSource(
      [[1, null, 3]],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      { stroke: '#f00', lineWidth: 1, lineDash: [2, 5], lineCap: 'round' }
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 2);

    expect(context.clip).toHaveBeenCalled();
    expect(context.moveTo).toHaveBeenCalledWith(0, 1);
    expect(context.lineTo).toHaveBeenCalledWith(2, 3);
  });

  test.each([
    { flag: CompactSeriesFlag.StepBefore, allowedRegion: [1, -5, 99, 110] },
    { flag: CompactSeriesFlag.StepAfter, allowedRegion: [0, -5, 1, 110] },
  ])('matches stepped dashed gap boundaries: %p', ({ flag, allowedRegion }) => {
    const source = createSource([[1, null, 3]], [flag | CompactSeriesFlag.DrawLine], 0, 'series', 'single', {
      stroke: '#f00',
      lineWidth: 2,
      lineDash: [2, 5],
    });
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 2);

    expect(context.rect).toHaveBeenCalledWith(...allowedRegion);
  });

  test('uses stepped gap clipping for solid stroke and fill', () => {
    const source = createSource(
      [[1, null, 3]],
      [CompactSeriesFlag.StepAfter | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      { stroke: '#f00', areaFill: '#f004', lineWidth: 2 }
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 2);

    expect(context.clip).toHaveBeenCalled();
    expect(context.fill).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    expect(context.rect).toHaveBeenCalledWith(0, -5, 1, 110);
  });

  test('finds connected endpoints outside a viewport containing only alignment absences', () => {
    const values = new Array<number | undefined>(101).fill(undefined);
    values[0] = 1;
    values[100] = 2;
    const source = createSource([values], [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine]);
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 40, 60);

    expect(context.moveTo).toHaveBeenCalledWith(0, 1);
    expect(context.lineTo).toHaveBeenCalledWith(100, 2);
  });

  test('uses the directional logarithmic scale edge as the fill baseline', () => {
    const source = createSource(
      [[2, 4]],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      { stroke: '#f00', areaFill: '#f004', lineWidth: 0 }
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    Reflect.set(plot, 'scales', { y: { min: 1, max: 100, distr: 3, dir: -1 } });

    controller.draw(plot, 0, 1);

    expect(context.moveTo).toHaveBeenCalledWith(0, 100);
  });

  test('reuses one opacity gradient per interned style during a draw', () => {
    const source = createSource(
      [
        [1, 2],
        [3, 4],
      ],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine, CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      { stroke: '#f00', areaGradient: ['rgba(255, 0, 0, 0.2)', 'rgba(255, 0, 0, 0)'], lineWidth: 0 }
    );
    const controller = new CompactRenderController(source);
    const { plot, context, gradient } = createPlot();

    controller.draw(plot, 0, 1);

    expect(context.createLinearGradient).toHaveBeenCalledTimes(1);
    expect(gradient.addColorStop).toHaveBeenNthCalledWith(1, 0, 'rgba(255, 0, 0, 0.2)');
    expect(gradient.addColorStop).toHaveBeenNthCalledWith(2, 1, 'rgba(255, 0, 0, 0)');
    expect(context.fill).toHaveBeenCalled();
  });

  test.each([
    { threshold: 0.5, spanThreshold: undefined, connected: false },
    { threshold: 1, spanThreshold: undefined, connected: true },
    { threshold: 0.5, spanThreshold: Number.POSITIVE_INFINITY, connected: true },
  ])('applies insertNulls and spanNulls segment topology: %p', ({ threshold, spanThreshold, connected }) => {
    const source = createSource(
      [[1, 2]],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      { stroke: '#f00', lineWidth: 1, disconnectThreshold: threshold, spanNullsThreshold: spanThreshold }
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 1);

    expect(context.moveTo).toHaveBeenCalledTimes(connected ? 1 : 2);
    expect(context.lineTo).toHaveBeenCalledTimes(connected ? 1 : 0);
  });

  test('draws formatted value labels only when point markers are visible', () => {
    const source = createSource([[1, 2]], [CompactSeriesFlag.Points], 0, 'series', 'single', {
      stroke: '#f00',
      pointSize: 4,
      showValues: true,
    });
    source.formatValueAt = (_series, _index, value) => `${value} ms`;
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 1);

    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(['1 ms', '2 ms']);
  });

  test('uses uPlot point spacing rather than configured marker size for auto points and values', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.AutoPoints], 0, 'series', 'single', {
      stroke: '#f00',
      pointSize: 100,
      pointSpace: 10,
      showValues: true,
    });
    source.formatValueAt = (_series, _index, value) => `${value}`;
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    plot.valToPos = (value) => value * 100;

    controller.draw(plot, 0, 2);

    expect(context.arc).toHaveBeenCalledTimes(3);
    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(['1', '2', '3']);
  });

  test.each([
    { flags: CompactSeriesFlag.Linear, pointSpace: 10, xScale: 100 },
    { flags: CompactSeriesFlag.AutoPoints, pointSpace: 100, xScale: 1 },
  ])('does not draw value labels without visible point markers: %p', ({ flags, pointSpace, xScale }) => {
    const source = createSource([[1, 2, 3]], [flags], 0, 'series', 'single', {
      stroke: '#f00',
      pointSpace,
      showValues: true,
    });
    source.formatValueAt = (_series, _index, value) => `${value}`;
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    plot.valToPos = (value) => value * xScale;

    controller.draw(plot, 0, 2);

    expect(context.arc).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();
  });
});

type TestSource = CompactRenderSource & {
  samples: Float64Array;
  scan: jest.MockedFunction<CompactRenderSource['scan']>;
};

function createVirtualSource(seriesCount: number, pointCount: number): TestSource {
  const samples = new Float64Array(1);
  const scan: jest.MockedFunction<CompactRenderSource['scan']> = jest.fn(
    (_series: number, from: number, to: number, visitor) => {
      for (let index = from; index <= to; index++) {
        visitor(index, index);
      }
    }
  );
  return {
    kind: 'compact-v1',
    buffer: samples.buffer,
    samples,
    pointCount,
    seriesCount,
    columns: {
      styleIds: new Uint8Array(seriesCount),
      scaleIds: new Uint8Array(seriesCount),
      flags: new Uint8Array(seriesCount).fill(CompactSeriesFlag.DrawLine),
      visibility: new Uint8Array(seriesCount).fill(1),
    },
    styles: [{ stroke: '#f00', lineWidth: 1 }],
    scales: [{ key: 'y', distribution: ScaleDistribution.Linear }],
    stackGroupCount: 0,
    cursorMode: 'single',
    focusAlpha: 1,
    visibilityState: { overrides: new Map() },
    release: () => structuredClone(samples.buffer, { transfer: [samples.buffer] }),
    xAt: (index) => index,
    closestXIndex: (value, from, to) => Math.max(from, Math.min(to, Math.round(value))),
    yAt: (_series, index) => index,
    scan,
    prepareBufferScan: () => false,
    extent: () => [0, pointCount - 1],
    nearestPresent: (_series, index) => index,
  };
}

function createSource(
  values: Array<Array<number | null | undefined>>,
  flags: number[],
  stackGroupCount = 0,
  identity = 'series',
  cursorMode: CompactRenderSource['cursorMode'] = 'single',
  style: CompactStyleRecord = { stroke: '#f00', fill: '#fcc', lineWidth: 1, pointSize: 4 }
): TestSource {
  const pointCount = values[0].length;
  const samples = new Float64Array(values.length * pointCount);
  const states = new Int8Array(values.length * pointCount);
  for (let series = 0; series < values.length; series++) {
    for (let index = 0; index < pointCount; index++) {
      const offset = series * pointCount + index;
      const value = values[series][index];
      states[offset] = value === undefined ? -1 : value === null ? 0 : 1;
      samples[offset] = typeof value === 'number' ? value : 0;
    }
  }

  const valueAt = (series: number, index: number) => {
    const offset = series * pointCount + index;
    return states[offset] < 0 ? undefined : states[offset] === 0 ? null : samples[offset];
  };
  const scan = jest.fn(
    (series: number, from: number, to: number, visitor: (index: number, value: number | null | undefined) => void) => {
      for (let index = from; index <= to; index++) {
        visitor(index, valueAt(series, index));
      }
    }
  );

  return {
    kind: 'compact-v1',
    buffer: samples.buffer,
    samples,
    pointCount,
    seriesCount: values.length,
    columns: {
      styleIds: new Uint8Array(values.length),
      scaleIds: new Uint8Array(values.length),
      flags: Uint8Array.from(flags),
      visibility: new Uint8Array(values.length).fill(1),
      stackGroupIds: new Uint8Array(values.length).fill(stackGroupCount === 0 ? 0 : 1),
    },
    styles: [style],
    scales: [{ key: 'y', distribution: ScaleDistribution.Linear }],
    stackGroupCount,
    cursorMode,
    focusAlpha: 1,
    seriesIdentityAt: (seriesIndex) => `${identity}:${seriesIndex}`,
    seriesIdentityHashAt: (seriesIndex) => seriesIndex,
    visibilityState: { overrides: new Map() },
    release: () => structuredClone(samples.buffer, { transfer: [samples.buffer] }),
    xAt: (index) => index,
    closestXIndex: (value, from, to) => Math.max(from, Math.min(to, Math.round(value))),
    yAt: valueAt,
    scan,
    prepareBufferScan: () => false,
    extent: (series, from, to, mode = 'all') => {
      let min: number | null = null;
      let max: number | null = null;
      for (let index = from; index <= to; index++) {
        const value = valueAt(series, index);
        if (value == null || (mode === 'positive' && value <= 0)) {
          continue;
        }
        min = min == null ? value : Math.min(min, value);
        max = max == null ? value : Math.max(max, value);
      }
      return [min, max];
    },
    nearestPresent: (series, index, bias) => {
      if (valueAt(series, index) != null) {
        return index;
      }
      if (bias !== 0) {
        for (let candidate = index; candidate >= 0 && candidate < pointCount; candidate += bias) {
          if (valueAt(series, candidate) != null) {
            return candidate;
          }
        }
        return null;
      }
      for (let distance = 1; distance < pointCount; distance++) {
        if (index - distance >= 0 && valueAt(series, index - distance) != null) {
          return index - distance;
        }
        if (index + distance < pointCount && valueAt(series, index + distance) != null) {
          return index + distance;
        }
      }
      return null;
    },
  };
}

function createPlot(): {
  plot: uPlot;
  context: jest.Mocked<CanvasRenderingContext2D>;
  gradient: { addColorStop: jest.Mock };
} {
  const gradient = { addColorStop: jest.fn() };
  const context = {
    save: jest.fn(),
    restore: jest.fn(),
    beginPath: jest.fn(),
    closePath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    quadraticCurveTo: jest.fn(),
    arc: jest.fn(),
    stroke: jest.fn(),
    fill: jest.fn(),
    clearRect: jest.fn(),
    fillRect: jest.fn(),
    strokeRect: jest.fn(),
    setLineDash: jest.fn(),
    rect: jest.fn(),
    clip: jest.fn(),
    createLinearGradient: jest.fn(() => gradient),
    fillText: jest.fn(),
  } as unknown as jest.Mocked<CanvasRenderingContext2D>;
  const plot = {
    ctx: context,
    bbox: { left: 0, top: 0, width: 100, height: 100 },
    scales: {
      x: { min: 0, max: 4, distr: 1, dir: 1, ori: 0 },
      y: { min: 0, max: 4, distr: 1, dir: 1, ori: 1 },
    },
    valToPos: (value: number) => value,
    posToVal: (value: number) => value,
  } as unknown as uPlot;
  return { plot, context, gradient };
}
