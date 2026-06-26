import uPlot from 'uplot';

import { ScaleDistribution, StackingMode } from '@grafana/schema';

import {
  CompactRenderController,
  CompactRenderSource,
  CompactSeriesFlag,
  CompactStyleRecord,
  getCompactRenderController,
  installCompactRenderer,
} from './compactRenderer';
import { UPlotConfigBuilder } from './config/UPlotConfigBuilder';

describe('CompactRenderController', () => {
  test('draws source-native lines, steps, points, splines, and gaps without dense arrays', () => {
    const source = createSource(
      [
        [1, 2, null, 4],
        [1, 2, 3, 4],
        [1, undefined, 3, 4],
        [1, 2, 3, 4],
      ],
      [
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine,
        CompactSeriesFlag.StepAfter | CompactSeriesFlag.DrawLine,
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Points,
        CompactSeriesFlag.Spline | CompactSeriesFlag.DrawLine,
      ]
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 3);

    expect(context.moveTo).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.arc).toHaveBeenCalled();
    expect(context.quadraticCurveTo).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    expect(source.scan).toHaveBeenCalled();
    expect(source.buffer).toBe(source.samples.buffer);
  });

  test('draws grouped bars directly from the compact source without aligned value arrays', () => {
    const source = createSource(
      [
        [1, undefined, 3],
        [3, 2, 1],
      ],
      [CompactSeriesFlag.Bars, CompactSeriesFlag.Bars],
      0,
      'series',
      'single',
      { stroke: '#f00', areaFill: '#fcc', lineWidth: 1, barWidthFactor: 0.8 }
    );
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0.8, barWidth: 0.8, barRadius: 0 });
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 2);

    expect(context.fill).toHaveBeenCalledTimes(5);
    expect(context.stroke).toHaveBeenCalledTimes(5);
    expect(source.scan).toHaveBeenCalledWith(0, 0, 2, expect.any(Function));
    expect(source.scan).toHaveBeenCalledWith(1, 0, 2, expect.any(Function));
    expect(source.buffer).toBe(source.samples.buffer);
    const bars = context.rect.mock.calls.slice(1);
    for (const [, , width] of bars) {
      expect(width).toBeCloseTo((100 / 3) * 0.8 * 0.4 - 1);
    }
    expect(bars[2][0] - bars[0][0]).toBeCloseTo((100 / 3) * 0.8 * 0.6);
  });

  test('maps grouped Bar chart timestamps onto categorical positions', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Bars]);
    source.xAt = (index) => [0, 10, 30][index];
    source.closestXIndex = jest.fn((value) => (value < 5 ? 0 : value < 20 ? 1 : 2));
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0.8, barWidth: 0.8 });
    const controller = new CompactRenderController(source);

    expect([0, 10, 30].map((value) => controller.groupedBarIndexAt(value))).toEqual([0, 1, 2]);
    expect(source.closestXIndex).not.toHaveBeenCalled();
    expect(controller.groupedBarValueAt(1.5)).toBe(20);
    const [minimum, maximum] = controller.groupedBarRange();
    expect(controller.groupedBarIndexAt(minimum)).toBeCloseTo(-4 / 11);
    expect(controller.groupedBarIndexAt(maximum)).toBeCloseTo(26 / 11);
    expect(controller.groupedBarSplits(minimum, maximum, 2)).toEqual([0, 30]);

    const { plot, context } = createPlot();
    const minimumIndex = controller.groupedBarIndexAt(minimum);
    const indexRange = controller.groupedBarIndexAt(maximum) - minimumIndex;
    plot.valToPos = (value, scaleKey) =>
      scaleKey === 'x' ? ((controller.groupedBarIndexAt(value) - minimumIndex) / indexRange) * 100 : 80 - value * 10;
    controller.draw(plot, 0, 2);
    const bars = context.rect.mock.calls.slice(1);
    expect(bars).toHaveLength(3);
    for (const [, , width] of bars) {
      expect(width).toBeCloseTo(80 / 3 - 1);
    }
  });

  test('keeps grouped Bar chart tick splits within the spacing budget', () => {
    const source = createSource([[1, 2, 3, 4, 5]], [CompactSeriesFlag.Bars]);
    source.xAt = (index) => index;
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0.8, barWidth: 0.8 });
    const controller = new CompactRenderController(source);
    const [minimum, maximum] = controller.groupedBarRange();

    expect(controller.groupedBarSplits(minimum, maximum, 2)).toEqual([0, 4]);
  });

  test('uses a precise grouped-bar time format for sparse and irregular samples', () => {
    const single = createSource([[1]], [CompactSeriesFlag.Bars]);
    const irregular = createSource([[1, 2, 3]], [CompactSeriesFlag.Bars]);
    const longIrregular = createSource([new Array(66).fill(1)], [CompactSeriesFlag.Bars]);
    irregular.xAt = (index) => [0, 100_000, 101_000][index];
    longIrregular.xAt = (index) => (index < 65 ? index * 100_000 : 6_401_000);

    expect(new CompactRenderController(single).groupedBarIncrement()).toBe(1000);
    expect(new CompactRenderController(irregular).groupedBarIncrement()).toBe(1000);
    expect(new CompactRenderController(longIrregular).groupedBarIncrement()).toBe(1000);
  });

  test('lays out currently visible grouped bars without exposing configured-hidden series', () => {
    const source = createSource(
      [[1], [2], [3]],
      [CompactSeriesFlag.Bars, CompactSeriesFlag.Bars, CompactSeriesFlag.Bars]
    );
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0.9, barWidth: 0.8 });
    Reflect.set(source, 'barLayoutVisibility', new Uint8Array([1, 1, 0]));
    source.columns.visibility[1] = 0;
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    expect(source.columns.visibility).toEqual(new Uint8Array([1, 0, 0]));
    controller.draw(plot, 0, 0);
    const isolatedBars = context.rect.mock.calls.slice(1);

    controller.setSeries(null, { show: true });
    controller.setSeries(2, { show: true });
    context.rect.mockClear();
    controller.draw(plot, 0, 0);
    const restoredBars = context.rect.mock.calls.slice(1);

    expect(source.columns.visibility).toEqual(new Uint8Array([1, 1, 0]));
    expect(isolatedBars).toHaveLength(1);
    expect(restoredBars).toHaveLength(2);
    expect(isolatedBars[0][2]).toBeGreaterThan(restoredBars[0][2]);
  });

  test('keeps an empty grouped-bar scale range non-degenerate', () => {
    const source = createSource([[]], [CompactSeriesFlag.Bars]);
    Reflect.set(source, 'barOptions', { mode: 'grouped' });
    const controller = new CompactRenderController(source);
    const [minimum, maximum] = controller.groupedBarRange();

    expect([controller.groupedBarIndexAt(minimum), controller.groupedBarIndexAt(maximum)]).toEqual([0, 1]);
  });

  test('keeps the grouped scale stable when its only configured bar is restored', () => {
    const source = createSource([[1, 2]], [CompactSeriesFlag.Bars]);
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0.7, barWidth: 0.9 });
    Reflect.set(source, 'barLayoutVisibility', new Uint8Array([1]));
    source.columns.visibility[0] = 0;
    const controller = new CompactRenderController(source);

    const hiddenRange = controller.groupedBarRange();
    controller.setSeries(0, { show: true });

    expect(controller.groupedBarRange()).toEqual(hiddenRange);
  });

  test('keeps configured point markers on TimeSeries bars', () => {
    const source = createSource([[1, 2]], [CompactSeriesFlag.Bars | CompactSeriesFlag.Points]);
    const { plot, context } = createPlot();

    new CompactRenderController(source).draw(plot, 0, 1);

    expect(context.arc).toHaveBeenCalledTimes(2);
  });

  test('keeps zero-width bar settings visible at the one-pixel minimum', () => {
    const source = createSource([[10]], [CompactSeriesFlag.Bars]);
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0, barWidth: 0 });
    const { plot, context } = createPlot();

    new CompactRenderController(source).draw(plot, 0, 0);

    expect(context.rect).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), uPlot.pxRatio, 10);
  });

  test.each([
    { middle: undefined, expectedWidth: 24 },
    { middle: null, expectedWidth: 12 },
  ])(
    'matches uPlot TimeSeries bar width and pixel rounding for a $middle middle sample',
    ({ middle, expectedWidth }) => {
      const source = createSource([[1.45, middle, 2.25]], [CompactSeriesFlag.Bars], 0, 'series', 'single', {
        stroke: '#f00',
        areaFill: '#fcc',
        lineWidth: 0,
        barWidthFactor: 0.6,
      });
      source.xAt = (index) => index * 10;
      if (middle === null) {
        source.scan.mockImplementation((_series, from, to, visitor) => {
          const renderValues = [1.45, undefined, 2.25];
          for (let index = from; index <= to; index++) {
            visitor(index, renderValues[index]);
          }
        });
      }
      source.cursorValueAt = jest.fn(source.cursorValueAt);
      const controller = new CompactRenderController(source);
      const { plot, context } = createPlot();
      plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value * 2 : 80 - value * 10);

      controller.draw(plot, 0, 2);

      const bars = context.rect.mock.calls.slice(1);
      expect(bars).toEqual([
        [-expectedWidth / 2, 66, expectedWidth, 14],
        [40 - expectedWidth / 2, 58, expectedWidth, 22],
      ]);
      expect(context.fill).toHaveBeenCalledTimes(1);
      expect(source.cursorValueAt).toHaveBeenCalledTimes(3);

      source.cursorValueAt.mockClear();
      controller.draw(plot, 0, 2);
      expect(source.cursorValueAt).not.toHaveBeenCalled();
    }
  );

  test('fills dense TimeSeries bars with the stroke color when uPlot suppresses their outlines', () => {
    for (const showValue of ['never', 'always'] as const) {
      const source = createSource([[1, 2]], [CompactSeriesFlag.Bars], 0, 'series', 'single', {
        stroke: '#f00',
        lineWidth: 1,
        barWidthFactor: 0.6,
      });
      Reflect.set(source, 'barOptions', { showValue });
      const { plot, context } = createPlot();
      plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value * 2.1 : 80 - value * 10);

      new CompactRenderController(source).draw(plot, 0, 1);

      expect(context.fill).toHaveBeenCalledTimes(showValue === 'never' ? 1 : 2);
      expect(context.fillStyle).toBe('#f00');
      expect(context.stroke).not.toHaveBeenCalled();
    }
  });

  test.each([
    {
      name: 'unstacked series',
      flags: CompactSeriesFlag.Bars,
      stackGroupCount: 0,
      expectedY: 65.5,
      expectedHeight: 14.5,
    },
    {
      name: 'bottom stack series',
      flags: CompactSeriesFlag.Bars | CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack,
      stackGroupCount: 1,
      expectedY: 70.4,
      expectedHeight: 9.6,
    },
  ])('keeps uPlot baseline rounding for a dense $name', ({ flags, stackGroupCount, expectedY, expectedHeight }) => {
    const source = createSource([[1.49, 2.25]], [flags], stackGroupCount, 'series', 'single', {
      stroke: '#f00',
      areaFill: '#fcc',
      lineWidth: 0,
      barWidthFactor: 0.6,
    });
    const { plot, context } = createPlot();
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value * 4 : 80.4 - value * 10);

    new CompactRenderController(source).draw(plot, 0, 1);

    const [, y, , height] = context.rect.mock.calls.slice(1)[0];
    expect(y).toBeCloseTo(expectedY);
    expect(height).toBeCloseTo(expectedHeight);
  });

  test.each([
    {
      name: 'unstacked series',
      flags: [CompactSeriesFlag.Bars, CompactSeriesFlag.Bars],
      stackGroupCount: 0,
    },
    {
      name: 'stacked series',
      flags: [CompactSeriesFlag.Bars | CompactSeriesFlag.Stack, CompactSeriesFlag.Bars | CompactSeriesFlag.Stack],
      stackGroupCount: 1,
    },
  ])(
    'matches global TimeSeries bar cadence for $name and refreshes it after hiding a series',
    ({ flags, stackGroupCount }) => {
      const source = createSource(
        [
          [1, undefined, 1],
          [1, 1, 1],
        ],
        flags,
        stackGroupCount,
        'series',
        'single',
        { stroke: '#f00', areaFill: '#fcc', lineWidth: 0, barWidthFactor: 0.6 }
      );
      source.xAt = (index) => [0, 1, 10][index];
      const controller = new CompactRenderController(source);
      const { plot, context } = createPlot();
      plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value * 10 : 80 - value * 10);

      controller.draw(plot, 0, 2);

      expect(context.rect.mock.calls.slice(1).map(([, , width]) => width)).toEqual([6, 6, 6, 6, 6]);

      controller.setSeries(1, { show: false });
      context.rect.mockClear();
      controller.draw(plot, 0, 2);
      expect(context.rect.mock.calls.slice(1).map(([, , width]) => width)).toEqual([60, 60]);
    }
  );

  test('uses pre-transform stack presence to size constant TimeSeries bars', () => {
    const flags = CompactSeriesFlag.Bars | CompactSeriesFlag.Stack;
    const source = createSource(
      [
        [1, undefined, undefined],
        [1, null, 1],
      ],
      [flags | CompactSeriesFlag.Constant, flags],
      1,
      'series',
      'single',
      { stroke: '#f00', areaFill: '#fcc', lineWidth: 0, barWidthFactor: 0.6 }
    );
    const barWidthValueAt = source.barWidthValueAt!;
    source.barWidthValueAt = (series, index) => (series === 0 ? 1 : barWidthValueAt(series, index));
    source.xAt = (index) => [0, 1, 10][index];
    const { plot, context } = createPlot();
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value * 10 : 80 - value * 10);

    new CompactRenderController(source).draw(plot, 0, 2);

    expect(context.rect.mock.calls.slice(1).map(([, , width]) => width)).toEqual([6, 6, 6]);
  });

  test('does not apply another series cadence to a constant TimeSeries stack', () => {
    const source = createSource(
      [
        [1, undefined, undefined],
        [1, 1, 1],
      ],
      [CompactSeriesFlag.Bars | CompactSeriesFlag.Stack | CompactSeriesFlag.Constant, CompactSeriesFlag.Bars],
      1,
      'series',
      'single',
      { stroke: '#f00', areaFill: '#fcc', lineWidth: 0, barWidthFactor: 0.6 }
    );
    Reflect.set(source.columns, 'stackGroupIds', new Uint8Array([1, 0]));
    const barWidthValueAt = source.barWidthValueAt!;
    source.barWidthValueAt = (series, index) =>
      series === 0 ? (index === 1 ? undefined : 1) : barWidthValueAt(series, index);
    source.xAt = (index) => [0, 1, 10][index];
    const { plot, context } = createPlot();
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value * 10 : 80 - value * 10);

    new CompactRenderController(source).draw(plot, 0, 2);

    expect(context.rect.mock.calls.slice(1).map(([, , width]) => width)).toEqual([60, 6, 6, 6]);
  });

  test('normalizes percent-stacked bars for extents and cursor focus', () => {
    const flags = CompactSeriesFlag.Bars | CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack;
    const source = createSource(
      [
        [1, 1],
        [3, 1],
      ],
      [flags, flags],
      1,
      'series',
      'single',
      { stroke: '#f00', areaFill: '#fcc', lineWidth: 1 }
    );
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.extent(plot, 'y', 0, 1)).toEqual([0, 1]);
    expect(controller.updateCursor(plot, 0, 1, 'local')).toMatchObject({
      seriesIndex: 1,
      dataIndex: 0,
      top: 1,
    });
  });

  test('configures percent-stacked value scales with the fixed 0 to 1 range', () => {
    const flags = CompactSeriesFlag.Bars | CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack;
    const source = createSource([[1], [3]], [flags, flags], 1);
    const builder = new UPlotConfigBuilder();

    installCompactRenderer(builder, source);

    expect(builder.scales[0].props.stackingMode).toBe(StackingMode.Percent);
  });

  test('formats stacked bar labels from segment values and rounds only exposed normal stacks', () => {
    const cases = [
      {
        flags: CompactSeriesFlag.Bars | CompactSeriesFlag.Stack,
        expected: [1, 1, 3, 1],
        roundedCorners: 4,
      },
      {
        flags: CompactSeriesFlag.Bars | CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack,
        expected: [0.25, 0.5, 0.75, 0.5],
        roundedCorners: 0,
      },
      {
        flags: CompactSeriesFlag.Bars | CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack,
        values: [
          [-1, -1],
          [-3, -1],
        ],
        expected: [0.25, 0.5, 0.75, 0.5],
        roundedCorners: 0,
      },
    ];

    for (const {
      flags,
      values = [
        [1, 1],
        [3, 1],
      ],
      expected,
      roundedCorners,
    } of cases) {
      const source = createSource(values, [flags, flags], 1, 'series', 'single', {
        stroke: '#f00',
        areaFill: '#fcc',
        lineWidth: 1,
      });
      const formatValueAt = jest.fn(() => 'value');
      Reflect.set(source, 'formatValueAt', formatValueAt);
      Reflect.set(source, 'barOptions', {
        mode: 'grouped',
        groupWidth: 0.8,
        barWidth: 0.8,
        barRadius: 0.2,
        showValue: 'always',
      });
      const { plot, context } = createPlot();
      plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value : 80 - value * 10);

      new CompactRenderController(source).draw(plot, 0, 1);

      expect(formatValueAt.mock.calls.map(([, , value]) => value)).toEqual([...expected, ...expected]);
      expect(context.quadraticCurveTo).toHaveBeenCalledTimes(roundedCorners);
    }
  });

  test('suppresses colliding auto labels within a stacked bar', () => {
    const flags = CompactSeriesFlag.Bars | CompactSeriesFlag.Stack;
    const source = createSource([[1], [1]], [flags, flags], 1);
    Reflect.set(source, 'formatValueAt', () => '1');
    Reflect.set(source, 'barOptions', {
      mode: 'grouped',
      groupWidth: 0.8,
      barWidth: 0.8,
      showValue: 'auto',
    });
    const { plot, context } = createPlot();
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value : 80 - value);

    new CompactRenderController(source).draw(plot, 0, 0);

    expect(context.fillText).toHaveBeenCalledTimes(1);
  });

  test('auto-sizes standalone bar values up to the legacy 30-pixel maximum', () => {
    const source = createSource([[1]], [CompactSeriesFlag.Bars], 0, 'series', 'single', {
      stroke: '#f00',
      areaFill: '#fcc',
      lineWidth: 0,
    });
    Reflect.set(source, 'formatValueAt', () => '1');
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0.8, barWidth: 1, showValue: 'always' });
    const { plot, context } = createPlot();
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value : 80 - value * 10);

    new CompactRenderController(source).draw(plot, 0, 0);

    expect(context.font).toBe('30px sans-serif');
  });

  test('uses one automatic font size across differently sized standalone bars', () => {
    const source = createSource([[1, 5]], [CompactSeriesFlag.Bars], 0, 'series', 'single', {
      stroke: '#f00',
      areaFill: '#fcc',
      lineWidth: 0,
    });
    Reflect.set(source, 'formatValueAt', () => '1');
    Reflect.set(source, 'barOptions', { mode: 'grouped', groupWidth: 0.8, barWidth: 1, showValue: 'always' });
    const { plot, context } = createPlot();
    plot.valToPos = (value, scaleKey) => (scaleKey === 'x' ? value : 80 - value * 10);
    const fonts: string[] = [];
    context.fillText.mockImplementation(() => fonts.push(context.font));

    new CompactRenderController(source).draw(plot, 0, 1);

    expect(fonts).toEqual(['25px sans-serif', '25px sans-serif']);
  });

  test('exposes a full bar-group cursor rectangle for standalone highlight mode', () => {
    const source = createSource([[1], [3]], [CompactSeriesFlag.Bars, CompactSeriesFlag.Bars], 0, 'series', 'single', {
      stroke: '#f00',
      areaFill: '#fcc',
      lineWidth: 1,
    });
    Reflect.set(source, 'barOptions', {
      mode: 'grouped',
      groupWidth: 0.8,
      barWidth: 1,
      fullHighlight: true,
    });
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 0, 80, 'local')).toMatchObject({
      hasPoint: true,
      seriesIndex: 0,
      centered: false,
      left: 0,
      top: 0,
      width: 40,
      height: 100,
    });
  });

  test('computes stacked extents with visible-window scratch and updates typed visibility', () => {
    const source = createSource(
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      [
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
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

  test('routes visibility through the current plot and preserves changes before attachment', () => {
    const source = createSource([[1, 2]], [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine]);
    const controller = new CompactRenderController(source);

    controller.setSeriesVisibility(0, false);
    expect(source.columns.visibility[0]).toBe(0);

    const { plot } = createPlot();
    plot.setSeries = jest.fn();
    controller.draw(plot, 0, 1);
    controller.setSeriesVisibility(0, true);

    expect(plot.setSeries).toHaveBeenCalledWith(1, { show: true });
  });

  test('matches legacy stack presence semantics across gaps', () => {
    const source = createSource(
      [
        [1, null, 3],
        [4, 5, null],
      ],
      [
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
      ],
      1
    );
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.extent(plot, 'y', 0, 2)).toEqual([0, 5]);
  });

  test('excludes the zero stack baseline from logarithmic extents', () => {
    const source = createSource(
      [
        [1, 2],
        [3, 4],
      ],
      [
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
      ],
      1
    );
    Reflect.set(source, 'scales', [{ key: 'y', distribution: ScaleDistribution.Log, mode: 'positive' }]);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.extent(plot, 'y', 0, 1)).toEqual([1, 6]);
  });

  test('fills stacked lines between the previous cumulative value and the current line', () => {
    const source = createSource(
      [
        [1, 1],
        [2, 2],
      ],
      [
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
        CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
      ],
      1,
      'series',
      'single',
      { stroke: '#f00', areaFill: '#fcc', lineWidth: 0 }
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();

    controller.draw(plot, 0, 1);

    expect(context.fill).toHaveBeenCalledTimes(2);
    expect(context.lineTo).toHaveBeenCalledWith(0, 1);
    expect(context.lineTo).toHaveBeenCalledWith(1, 1);
  });

  test('uses cumulative stack coordinates for cursor focus', () => {
    const source = createSource([[1], [4]], [CompactSeriesFlag.Stack, CompactSeriesFlag.Stack], 1);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 0, 5, 'local')).toMatchObject({ seriesIndex: 1, dataIndex: 0, top: 5 });
  });

  test('computes stacked cursor values at each gap-resolved timestamp', () => {
    const source = createSource(
      [
        [1, null, 100],
        [10, 20, null],
      ],
      [CompactSeriesFlag.Stack, CompactSeriesFlag.Stack],
      1
    );
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 20, 'native-sync')).toMatchObject({
      seriesIndex: 1,
      dataIndex: 1,
      top: 20,
    });
  });

  test('keeps stacked cursor values exact across many gap-resolved timestamps', () => {
    const source = createSource(
      Array.from({ length: 6 }, (_, series) => [
        series + 1,
        series + 1,
        series + 1,
        series + 1,
        series + 1,
        series + 1,
        null,
      ]),
      new Array(6).fill(CompactSeriesFlag.Stack),
      1
    );
    source.nearestPresent = (series) => series;
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 6, 21, 'native-sync')).toMatchObject({
      hasPoint: true,
      seriesIndex: 5,
      dataIndex: 5,
      top: 21,
    });
  });

  test('preserves query-owned response storage after transferring controller ownership', () => {
    const first = createSource([[1, 2]], [CompactSeriesFlag.Linear]);
    const release = jest.fn(first.release);
    first.release = release;
    const second = createSource([[3, 4]], [CompactSeriesFlag.Linear]);
    const controller = new CompactRenderController(first);

    controller.replaceSource(first, second);
    expect(getCompactRenderController(second)).toBe(controller);
    expect(release).not.toHaveBeenCalled();
    expect(first.buffer.byteLength).toBeGreaterThan(0);
    expect(second.buffer.byteLength).toBeGreaterThan(0);
    expect(() => controller.replaceSource(first, second)).toThrow('ownership mismatch');
    const growing = createSource(
      [
        [5, 6],
        [7, 8],
      ],
      [CompactSeriesFlag.Stack, CompactSeriesFlag.Stack],
      1
    );
    expect(() => controller.replaceSource(second, growing)).not.toThrow();
    expect(growing.seriesCount).toBe(2);
    expect(() =>
      controller.replaceSource(
        growing,
        createSource(
          [
            [5, 6],
            [7, 8],
          ],
          [
            CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack,
            CompactSeriesFlag.Stack | CompactSeriesFlag.PercentStack,
          ],
          1
        )
      )
    ).toThrow('percent scale usage');

    controller.destroy(growing);
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

  test('drops response ownership from snapshots when the renderer is destroyed', () => {
    const source = createSource([[1, 2]], [CompactSeriesFlag.Linear], 0, 'series', 'multi');
    const controller = new CompactRenderController(source);
    const snapshot = controller.getCursorSnapshot(0);

    expect(snapshot.source).toBe(source);
    controller.destroy(source);

    expect(snapshot.source).not.toBe(source);
    expect(snapshot.seriesCount).toBe(0);
    expect(source.buffer.byteLength).toBeGreaterThan(0);
  });

  test.each(['focused visibility change', 'source replacement', 'destruction'] as const)(
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
        if (action === 'focused visibility change') {
          controller.setSeries(0, { focus: true });
        }

        const completed = controller.draw(plot, 0, 999);

        expect(completed).toBeInstanceOf(Promise);
        expect(source.scan.mock.calls.length).toBeGreaterThan(0);
        expect(source.scan.mock.calls.length).toBeLessThan(source.seriesCount);
        expect(callbacks.size).toBe(1);

        if (action === 'focused visibility change') {
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

    const cursor = controller.updateCursor(plot, 1, 10, 'local');
    expect(cursor).toMatchObject({ seriesIndex: 1, dataIndex: 1, top: 11 });

    controller.setSeries(1, { show: false });
    expect(controller.updateCursor(plot, 1, 2, 'local')).toMatchObject({ seriesIndex: 0, dataIndex: 0, top: 1 });
  });

  test.each([
    {
      name: 'solid',
      values: [
        [500, 500],
        [1800, 1800],
      ],
      flags: [CompactSeriesFlag.DrawLine, CompactSeriesFlag.DrawLine],
      stackGroupCount: 0,
      fill: { areaFill: 'rgba(0, 0, 255, 0.2)' },
    },
    {
      name: 'gradient',
      values: [
        [500, 500],
        [1800, 1800],
      ],
      flags: [CompactSeriesFlag.DrawLine, CompactSeriesFlag.DrawLine],
      stackGroupCount: 0,
      fill: { areaGradient: ['rgba(0, 0, 255, 0.2)', 'rgba(0, 0, 255, 0)'] as const },
    },
    {
      name: 'stacked',
      values: [
        [500, 500],
        [1300, 1300],
      ],
      flags: [
        CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
        CompactSeriesFlag.DrawLine | CompactSeriesFlag.Stack,
      ],
      stackGroupCount: 1,
      fill: { areaFill: 'rgba(0, 0, 255, 0.2)' },
    },
  ])('treats a $name area fill as a focus target while keeping the cursor point on the line', (testCase) => {
    const source = createSource(testCase.values, testCase.flags, testCase.stackGroupCount, 'series', 'single', {
      stroke: '#00f',
      cursorStroke: '#0000ff80',
      lineWidth: 1,
      ...testCase.fill,
    });
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 1200, 'local')).toMatchObject({
      hasPoint: true,
      seriesIndex: 1,
      dataIndex: 1,
      distance: 0,
      top: 1800,
    });
    expect(controller.updateCursor(plot, 1, 520, 'local')).toMatchObject({
      hasPoint: true,
      seriesIndex: 0,
      dataIndex: 1,
      distance: 20,
      top: 500,
    });
  });

  test('uses the nearest present sample when cursor focus lands on a series gap', () => {
    const source = createSource([[1, null, 3]], [CompactSeriesFlag.Linear]);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 1, 'local')).toMatchObject({ seriesIndex: 0, dataIndex: 0, top: 1 });
  });

  test('matches legacy pointer proximity when a gap is between two samples', () => {
    const source = createSource([[1, null, 3]], [CompactSeriesFlag.Linear], 0, 'series', 'multi');
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    plot.cursor.left = 1.25;
    expect(controller.updateCursor(plot, 1, 3, 'local')).toMatchObject({ seriesIndex: 0, dataIndex: 2, top: 3 });
    const rightSnapshot = controller.getCursorSnapshot(1);
    expect(rightSnapshot.dataIndexAt(0)).toBe(2);
    const rightRevision = rightSnapshot.revision;

    plot.cursor.left = 0.75;
    expect(controller.updateCursor(plot, 1, 1, 'local')).toMatchObject({ seriesIndex: 0, dataIndex: 0, top: 1 });
    const leftSnapshot = controller.getCursorSnapshot(1);
    expect(leftSnapshot.dataIndexAt(0)).toBe(0);
    expect(leftSnapshot.revision).toBeGreaterThan(rightRevision);

    plot.cursor.left = 1.5;
    plot.cursor.hover!.prox = 0.25;
    expect(controller.updateCursor(plot, 1, 2, 'local')).toMatchObject({ hasPoint: false, seriesIndex: -1 });
  });

  test('applies hover proximity when only one present sample borders a gap', () => {
    const source = createSource([[1, null, null]], [CompactSeriesFlag.Linear], 0, 'series', 'multi');
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();
    plot.valToPos = (value) => value * 100;
    plot.posToVal = (value) => value / 100;
    plot.cursor.left = 200;
    plot.cursor.hover!.prox = 15;

    expect(controller.updateCursor(plot, 2, 1, 'local')).toMatchObject({ hasPoint: false, seriesIndex: -1 });
    expect(controller.getCursorSnapshot(2).valueAt(0)).toBeNull();
  });

  test('applies explicit hover proximity to present samples', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Linear], 0, 'series', 'single');
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();
    plot.cursor.left = 1.5;
    plot.cursor.hover!.prox = 0.25;

    expect(controller.updateCursor(plot, 1, 2, 'local')).toMatchObject({ hasPoint: false, seriesIndex: -1 });
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
    source.cursorValueAt = jest.fn(source.cursorValueAt);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 10, 'local')).toMatchObject({ seriesIndex: 1, dataIndex: 1, top: 11 });
    expect(source.cursorValueAt).toHaveBeenCalledTimes(2);
  });

  test('reuses exact multi-tooltip values while resolving focus indexes separately', () => {
    const source = createSource(
      [
        [1, null, 3],
        [10, 11, 12],
      ],
      [CompactSeriesFlag.Linear, CompactSeriesFlag.Linear],
      0,
      'series',
      'multi'
    );
    source.cursorValueAt = jest.fn(source.cursorValueAt);
    source.yAt = jest.fn(source.yAt);
    source.nearestPresent = jest.fn(source.nearestPresent);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    controller.updateCursor(plot, 1, 10, 'local');
    const firstSnapshot = controller.getCursorSnapshot(1);
    const firstRevision = firstSnapshot.revision;
    expect(firstSnapshot.valueAt(0)).toBeNull();
    expect(firstSnapshot.dataIndexAt(0)).toBe(0);
    expect(firstSnapshot.valueAt(1)).toBe(11);
    expect(source.cursorValueAt).toHaveBeenCalledTimes(2);
    expect(source.yAt).toHaveBeenCalledTimes(1);
    expect(source.nearestPresent).toHaveBeenCalledTimes(2);

    controller.updateCursor(plot, 1, 2, 'local');
    expect(controller.getCursorSnapshot(1)).toBe(firstSnapshot);
    expect(firstSnapshot.revision).toBe(firstRevision);
    expect(source.cursorValueAt).toHaveBeenCalledTimes(2);
    expect(source.yAt).toHaveBeenCalledTimes(2);
    expect(source.nearestPresent).toHaveBeenCalledTimes(2);

    controller.updateCursor(plot, 2, 2, 'local');
    expect(source.cursorValueAt).toHaveBeenCalledTimes(4);
    expect(source.yAt).toHaveBeenCalledTimes(2);
  });

  test('preserves null, undefined, and NaN cursor values', () => {
    const source = createSource(
      [[null], [undefined], [Number.NaN]],
      [CompactSeriesFlag.Linear, CompactSeriesFlag.Linear, CompactSeriesFlag.Linear],
      0,
      'series',
      'multi'
    );
    source.nearestPresent = () => null;
    const snapshot = new CompactRenderController(source).getCursorSnapshot(0);

    expect(snapshot.valueAt(0)).toBeNull();
    expect(snapshot.valueAt(1)).toBeUndefined();
    expect(snapshot.valueAt(2)).toBeNaN();
  });

  test('does not select non-finite cursor points', () => {
    const source = createSource([[Number.NaN]], [CompactSeriesFlag.Linear]);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 0, 0, 'local')).toMatchObject({ hasPoint: false, seriesIndex: -1 });
  });

  test('snaps a synchronized cursor to the nearest receiver-local point', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Linear]);
    source.cursorValueAt = jest.fn(source.cursorValueAt);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 10, 'native-sync')).toMatchObject({
      seriesIndex: 0,
      dataIndex: 1,
      left: 1,
      top: 2,
    });
    expect(source.cursorValueAt).not.toHaveBeenCalled();

    expect(controller.getCursorSnapshot(1).valueAt(0)).toBe(2);
    expect(source.cursorValueAt).toHaveBeenCalledTimes(1);
  });

  test('defers a synchronized tooltip snapshot until the tooltip consumes it', () => {
    const source = createSource(
      [
        [1, 2, 3],
        [10, 11, 12],
      ],
      [CompactSeriesFlag.Linear, CompactSeriesFlag.Linear]
    );
    source.cursorValueAt = jest.fn(source.cursorValueAt);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 10, 'native-sync')).toMatchObject({
      seriesIndex: 1,
      dataIndex: 1,
      top: 11,
    });
    expect(source.cursorValueAt).not.toHaveBeenCalled();
    expect(controller.getCursorSnapshot(1, plot).valueAt(1)).toBe(11);
    expect(source.cursorValueAt).toHaveBeenCalledTimes(2);
  });

  test('keeps cursor point selection independent from tooltip visibility', () => {
    const source = createSource([[1, 2, 3]], [CompactSeriesFlag.Linear], 0, 'series', 'none');
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();

    expect(controller.updateCursor(plot, 1, 2, 'local')).toMatchObject({
      seriesIndex: 0,
      dataIndex: 1,
      top: 2,
      size: 8,
      fill: '#f00',
      stroke: '#ff000080',
    });
  });

  test('clears candidate coordinates when focus proximity rejects the nearest point', () => {
    const source = createSource([[10]], [CompactSeriesFlag.Linear]);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();
    plot.focus.prox = 1;

    expect(controller.updateCursor(plot, 0, 0, 'local')).toMatchObject({
      hasPoint: false,
      seriesIndex: -1,
      dataIndex: -1,
      left: -10,
      top: -10,
      size: 0,
    });
  });

  test('keeps synchronized markers on the nearest receiver-local series across different scales', () => {
    const source = createSource([[10]], [CompactSeriesFlag.Linear]);
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();
    plot.focus.prox = 1;

    expect(controller.updateCursor(plot, 0, 0, 'native-sync')).toMatchObject({
      hasPoint: true,
      seriesIndex: 0,
      dataIndex: 0,
      top: 10,
      size: 8,
    });
  });

  test('keeps exact gap values while applying plot-aware focus proximity', () => {
    const source = createSource([[1, null, 3]], [CompactSeriesFlag.Linear], 0, 'series', 'single');
    const controller = new CompactRenderController(source);
    const { plot } = createPlot();
    Reflect.set(plot, 'cursor', { left: 100, top: 1, event: null, hover: { prox: 15 } });

    expect(controller.updateCursor(plot, 1, 1, 'native-sync')).toMatchObject({
      hasPoint: false,
      seriesIndex: -1,
    });
    expect(controller.getCursorSnapshot(1, plot).valueAt(0)).toBeNull();

    Reflect.set(plot, 'cursor', { left: 1.9, top: 1, event: null, hover: { prox: 15 } });
    const snapshot = controller.getCursorSnapshot(1, plot);
    expect(snapshot.valueAt(0)).toBeNull();
    expect(snapshot.dataIndexAt(0)).toBe(2);
  });

  test('draws and clears a focused-series overlay without rebuilding the complete plot', () => {
    const source = createSource(
      [
        [1, 2, 3],
        [3, 2, 1],
      ],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine, CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      undefined,
      'rgba(0, 0, 0, 0.5)'
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    const parent = document.createElement('div');
    const mainCanvas = document.createElement('canvas');
    const over = document.createElement('div');
    parent.append(mainCanvas, over);
    Object.defineProperty(context, 'canvas', { value: mainCanvas });
    Reflect.set(plot, 'over', over);
    let backdropFillStyle: string | CanvasGradient | CanvasPattern | undefined;
    const overlayContext = {
      ...context,
      clearRect: jest.fn(),
      fillRect: jest.fn(() => {
        backdropFillStyle = overlayContext.fillStyle;
      }),
      stroke: jest.fn(),
    } as unknown as jest.Mocked<CanvasRenderingContext2D>;
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      Object.defineProperty(overlayContext, 'canvas', { value: this, configurable: true });
      return overlayContext;
    });

    try {
      controller.draw(plot, 0, 2);
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();

      expect(controller.setSeries(0, { focus: true })).toBe(false);
      expect(parent.querySelectorAll('.u-compact-focus-overlay')).toHaveLength(1);
      expect(backdropFillStyle).toBe('rgba(0, 0, 0, 0.5)');
      expect(overlayContext.fillRect).toHaveBeenCalledWith(0, 0, 100, 100);
      expect(overlayContext.strokeStyle).toBe('#f00');

      expect(controller.setSeries(1, { show: false })).toBe(true);
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();
      expect(controller.setSeries(1, { focus: true })).toBe(false);
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();

      expect(controller.setSeries(null, { focus: true })).toBe(false);
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();
      controller.destroy(source);
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();
    } finally {
      getContext.mockRestore();
    }
  });

  test('does not create a focused-series overlay when only one series is visible', () => {
    const source = createSource(
      [[1, 2, 3]],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      undefined,
      'rgba(0, 0, 0, 0.5)'
    );
    const controller = new CompactRenderController(source);
    const { plot, context } = createPlot();
    const parent = document.createElement('div');
    const mainCanvas = document.createElement('canvas');
    const over = document.createElement('div');
    parent.append(mainCanvas, over);
    Object.defineProperty(context, 'canvas', { value: mainCanvas });
    Reflect.set(plot, 'over', over);

    controller.draw(plot, 0, 2);
    expect(controller.setSeries(0, { focus: true })).toBe(false);
    expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();
  });

  test('restores requested focus when a second series becomes visible', () => {
    const source = createSource(
      [
        [1, 2, 3],
        [3, 2, 1],
      ],
      [CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine, CompactSeriesFlag.Linear | CompactSeriesFlag.DrawLine],
      0,
      'series',
      'single',
      undefined,
      'rgba(0, 0, 0, 0.5)'
    );
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
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      Object.defineProperty(overlayContext, 'canvas', { value: this, configurable: true });
      return overlayContext;
    });

    try {
      controller.draw(plot, 0, 2);
      controller.setSeries(1, { show: false });
      controller.setSeries(0, { focus: true });
      expect(parent.querySelector('.u-compact-focus-overlay')).toBeNull();

      controller.setSeries(1, { show: true });
      expect(parent.querySelectorAll('.u-compact-focus-overlay')).toHaveLength(1);
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
    styles: [{ stroke: '#f00', cursorStroke: '#ff000080', lineWidth: 1 }],
    scales: [{ key: 'y', distribution: ScaleDistribution.Linear }],
    stackGroupCount: 0,
    cursorMode: 'single',
    visibilityState: { overrides: new Map() },
    release: () => undefined,
    xAt: (index) => index,
    closestXIndex: (value, from, to) => Math.max(from, Math.min(to, Math.round(value))),
    cursorValueAt: (_series, index) => index,
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
  style: Omit<CompactStyleRecord, 'cursorStroke'> & { cursorStroke?: string } = {
    stroke: '#f00',
    cursorStroke: '#ff000080',
    fill: '#fcc',
    lineWidth: 1,
    pointSize: 4,
  },
  focusOverlayColor?: string
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
      flags: Uint16Array.from(flags),
      visibility: new Uint8Array(values.length).fill(1),
      stackGroupIds: new Uint8Array(values.length).fill(stackGroupCount === 0 ? 0 : 1),
    },
    styles: [{ ...style, cursorStroke: style.cursorStroke ?? style.stroke }],
    scales: [{ key: 'y', distribution: ScaleDistribution.Linear }],
    stackGroupCount,
    cursorMode,
    focusOverlayColor,
    seriesIdentityAt: (seriesIndex) => `${identity}:${seriesIndex}`,
    seriesIdentityHashAt: (seriesIndex) => seriesIndex,
    visibilityState: { overrides: new Map() },
    release: () => undefined,
    xAt: (index) => index,
    closestXIndex: (value, from, to) => Math.max(from, Math.min(to, Math.round(value))),
    barWidthValueAt: valueAt,
    cursorValueAt: valueAt,
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
    measureText: jest.fn(() => ({ width: 8 })),
    fillText: jest.fn(),
  } as unknown as jest.Mocked<CanvasRenderingContext2D>;
  const plot = {
    ctx: context,
    bbox: { left: 0, top: 0, width: 100, height: 100 },
    scales: {
      x: { min: 0, max: 4, distr: 1, dir: 1, ori: 0 },
      y: { min: 0, max: 4, distr: 1, dir: 1, ori: 1 },
    },
    cursor: {
      left: 1,
      top: 1,
      event: {},
      hover: { prox: 15 },
    },
    focus: {
      prox: 30,
      bias: 0,
      dist: (_plot: uPlot, _seriesIndex: number, _dataIndex: number, valuePos: number, cursorPos: number) =>
        valuePos - cursorPos,
    },
    valToPos: (value: number) => value,
    posToVal: (value: number) => value,
  } as unknown as uPlot;
  return { plot, context, gradient };
}
