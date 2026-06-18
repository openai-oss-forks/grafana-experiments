import uPlot from 'uplot';

import {
  createTheme,
  dateTime,
  type DataQuery,
  FieldConfigOptionsRegistry,
  FieldConfigProperty,
  type FieldConfigSource,
  type FieldOverrideContext,
  FieldType,
  ThresholdsMode,
} from '@grafana/data';
import { toDataQueryResponse } from '@grafana/runtime';
import { GraphThresholdsStyleMode } from '@grafana/schema';
import { installCompactRenderer, UPlotConfigBuilder } from '@grafana/ui/internal';

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

  test('installs compact threshold overlays from scale-owned configuration', () => {
    const thresholds = {
      mode: ThresholdsMode.Absolute,
      steps: [
        { color: 'green', value: -Infinity },
        { color: 'red', value: 2 },
      ],
    };
    const plan = createPlan(
      decodeFixture(),
      {
        defaults: {
          thresholds,
          custom: { thresholdsStyle: { mode: GraphThresholdsStyleMode.LineAndArea } },
        },
        overrides: [],
      },
      new FieldConfigOptionsRegistry(() => [
        compactProperty(FieldConfigProperty.Thresholds, 'thresholds', false),
        compactProperty('custom.thresholdsStyle', 'thresholdsStyle', true),
      ])
    );

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

    expect(plan.getScale(0).config.thresholds).toEqual(thresholds);
    expect(builder.getConfig().hooks?.drawClear).toHaveLength(1);
  });
});

function createPlan(
  buffer: ArrayBuffer,
  fieldConfig: FieldConfigSource = { defaults: {}, overrides: [] },
  fieldConfigRegistry = new FieldConfigOptionsRegistry()
) {
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
    fieldConfig,
    fieldConfigRegistry,
    replaceVariables: (value) => value,
    theme: createTheme(),
    timeZone: 'utc',
    cursorMode: 'multi',
  });
}

function compactProperty(id: string, path: string, isCustom: boolean) {
  return {
    id,
    path,
    name: id,
    isCustom,
    editor: () => null,
    override: () => null,
    process: (value: unknown, _context: FieldOverrideContext) => value,
    shouldApply: (target: { type: FieldType }) => target.type === FieldType.number,
  };
}

function decodeFixture(): ArrayBuffer {
  const binary = window.atob(COMPACT_FIXTURE);
  return Uint8Array.from(binary, (value) => value.charCodeAt(0)).buffer;
}

async function flushCommit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
