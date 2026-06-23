import uPlot from 'uplot';

import {
  createTheme,
  dateTime,
  dateTimeFormat,
  type DataQuery,
  FieldConfigOptionsRegistry,
  systemDateFormats,
} from '@grafana/data';
import { toDataQueryResponse } from '@grafana/runtime';
import { VizOrientation } from '@grafana/schema';
import { getCompactRenderController, installCompactRenderer, UPlotConfigBuilder } from '@grafana/ui/internal';

import { prepareCompactPlotConfigBuilder } from '../TimeSeries/utils';

import { createCompactNativeRenderPlan } from './compactNativePlan';

const COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
// One A series on a regular three-point axis, with values 0, gap, 4 and a region label.
const COMPACT_FIXTURE =
  'R1FEMQEAAAABAAAAAQAAAAUAAAAXAAAAAAAAAAAAAADoAwAAAAAAAOgDAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAQAAAAgAAAAJAAAABwAAABAAAAAHAAAAQXJlcXVlc3RzY2x1c3RlcnpvbmUtMDEAgAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAEAAAABAAAAAAAAAAAAUAAAAAAAAAACAAAAAQAAAAAAAAABAAAAAgAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAwAAAAQAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAEEA=';

describe('compact binary rendering pipeline', () => {
  test('keeps the response buffer as sample storage through uPlot replacement and destruction', async () => {
    const firstBuffer = decodeFixture();
    const firstBufferBytes = firstBuffer.byteLength;
    const firstPlan = createPlan(firstBuffer);
    const builder = new UPlotConfigBuilder('utc');
    const controller = installCompactRenderer(builder, firstPlan.source);
    const target = document.createElement('div');
    const plot = uPlot.compact(
      { width: 300, height: 200, ...builder.getConfig(), axes: [] },
      firstPlan.source,
      controller,
      target
    );
    await flushCommit();

    expect(firstPlan.data.buffer).toBe(firstBuffer);
    expect(firstPlan.source.buffer).toBe(firstBuffer);
    expect(firstPlan).not.toHaveProperty('series');
    expect(firstPlan.source.yAt(0, 0)).toBe(0);
    expect(firstPlan.source.yAt(0, 1)).toBeNull();
    expect(firstPlan.source.yAt(0, 2)).toBe(4);
    expect(plot.compactSource).toBe(firstPlan.source);
    expect(plot.data).toEqual([[]]);
    expect(plot.series).toHaveLength(1);
    expect(target.querySelector('canvas')).not.toBeNull();
    expect(() => plot.setData([[], []])).toThrow('setCompactData');

    const secondBuffer = decodeFixture();
    const secondPlan = createPlan(secondBuffer);
    plot.setCompactData!(secondPlan.source);
    await flushCommit();

    expect(secondPlan.source.buffer).toBe(secondBuffer);
    expect(firstBuffer.byteLength).toBe(firstBufferBytes);
    expect(firstPlan.source.yAt(0, 2)).toBe(4);
    expect(plot.compactSource).toBe(secondPlan.source);
    expect(plot.compactSource?.buffer).not.toBe(firstBuffer);

    plot.destroy();
    expect(plot.compactSource).toBeNull();
    expect(secondBuffer.byteLength).toBe(firstBufferBytes);
    expect(target.contains(plot.root)).toBe(false);
  });

  test('reads default gap proximity from the active compact source after replacement', () => {
    const plan = createPlan(decodeFixture());
    const builder = prepareCompactPlotConfigBuilder({
      plan,
      theme: createTheme(),
      timeZones: ['utc'],
      getTimeRange: () => ({
        from: dateTime(1000),
        to: dateTime(3000),
        raw: { from: dateTime(1000), to: dateTime(3000) },
      }),
    });
    const proximity = builder.getConfig().cursor?.hover?.prox;
    if (typeof proximity !== 'function') {
      throw new Error('Expected compact default cursor proximity callback');
    }
    const plot = {
      compactSource: { yAt: jest.fn(() => null) },
    } as unknown as uPlot;

    expect(proximity(plot, 1, 1, 2000)).toBe(15);
    Reflect.set(plot, 'compactSource', { yAt: jest.fn(() => 4) });
    expect(proximity(plot, 1, 1, 2000)).toBeNull();
  });

  test('configures standalone bars with categorical X geometry and orientation-aware drag', async () => {
    const plan = createPlan(decodeFixture());
    Reflect.set(plan.source, 'barOptions', { mode: 'grouped', groupWidth: 0.8, barWidth: 1 });
    const builder = prepareCompactPlotConfigBuilder({
      plan,
      theme: createTheme(),
      timeZones: ['utc'],
      getTimeRange: () => ({
        from: dateTime(1000),
        to: dateTime(3000),
        raw: { from: dateTime(1000), to: dateTime(3000) },
      }),
      orientation: VizOrientation.Vertical,
      xAxisConfig: { tickLabelRotation: 0 },
      valueAxisConfig: { tickLabelRotation: -30, filter: jest.fn((_plot, splits) => splits) },
    });

    const config = builder.getConfig();
    expect(config.scales?.x).toMatchObject({ time: false, distr: 100 });
    expect(config.axes?.[0]).toMatchObject({ scale: 'x', rotate: 0, values: expect.any(Function) });
    expect(config.axes?.[1]).toMatchObject({ rotate: -30, filter: expect.any(Function) });
    const formatTicks = config.axes?.[0].values;
    if (typeof formatTicks !== 'function') {
      throw new Error('Expected compact grouped-bar tick formatter');
    }
    expect(formatTicks({} as uPlot, [1000, 2000, 3000], 0, 0, 1000)).toEqual(
      [1000, 2000, 3000].map((value) =>
        dateTimeFormat(value, { format: systemDateFormats.interval.second, timeZone: 'utc' })
      )
    );
    expect(config.scales?.x.fwd?.(1000)).toBe(0);
    expect(config.scales?.x.fwd?.(3000)).toBe(2);
    expect(config.scales?.x.bwd?.(1.5)).toBe(2500);
    expect(config.cursor?.drag).toMatchObject({ x: false, y: false, setScale: false });

    const plot = uPlot.compact(
      { width: 300, height: 200, ...config },
      plan.source,
      getCompactRenderController(plan.source),
      document.createElement('div')
    );
    await flushCommit();
    const positions = [1000, 2000, 3000].map((value) => plot.valToPos(value, 'x'));
    expect(Math.abs(positions[1] - positions[0])).toBeCloseTo(Math.abs(positions[2] - positions[1]));
    plot.destroy();
  });
});

function createPlan(buffer: ArrayBuffer) {
  const response = toDataQueryResponse(
    {
      data: buffer,
      headers: new Headers({ 'content-type': COMPACT_MEDIA_TYPE }),
    },
    [{ refId: 'A' } as DataQuery],
    true
  );

  expect(response.data).toEqual([]);
  expect(response.compactSeries?.buffer).toBe(buffer);

  return createCompactNativeRenderPlan(response.compactSeries!, {
    fieldConfig: { defaults: {}, overrides: [] },
    fieldConfigRegistry: new FieldConfigOptionsRegistry(),
    replaceVariables: (value) => value,
    theme: createTheme(),
    timeZone: 'utc',
    cursorMode: 'multi',
  });
}

function decodeFixture(): ArrayBuffer {
  const binary = window.atob(COMPACT_FIXTURE);
  return Uint8Array.from(binary, (value) => value.charCodeAt(0)).buffer;
}

async function flushCommit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
