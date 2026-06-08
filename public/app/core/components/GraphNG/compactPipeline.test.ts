import uPlot from 'uplot';

import { createTheme, type DataQuery, FieldConfigOptionsRegistry } from '@grafana/data';
import { toDataQueryResponse } from '@grafana/runtime';
import { installCompactRenderer, UPlotConfigBuilder } from '@grafana/ui/internal';

import { createCompactNativeRenderPlan } from './compactNativePlan';

const COMPACT_MEDIA_TYPE = 'application/vnd.grafana.querydata.compact;version=1';
// One A series on a regular three-point axis, with values 0, gap, 4 and a region label.
const COMPACT_FIXTURE =
  'R1FEMQEAAAABAAAAAQAAAAUAAAAXAAAAAAAAAAAAAADoAwAAAAAAAOgDAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAQAAAAgAAAAJAAAABwAAABAAAAAHAAAAQXJlcXVlc3RzY2x1c3RlcnpvbmUtMDEAgAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAEAAAABAAAAAAAAAAAAUAAAAAAAAAACAAAAAQAAAAAAAAABAAAAAgAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAwAAAAQAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAEEA=';

describe('compact binary rendering pipeline', () => {
  test('keeps the response buffer as sample storage through uPlot replacement and destruction', async () => {
    const firstBuffer = decodeFixture();
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
    expect(plot.compactSource).toBe(secondPlan.source);
    expect(plot.compactSource?.buffer).not.toBe(firstBuffer);

    plot.destroy();
    expect(plot.compactSource).toBeNull();
    expect(target.contains(plot.root)).toBe(false);
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
