import {
  colorManipulator,
  COMPACT_TIME_SERIES_FORMAT,
  CompactTimeSeriesData,
  CompactTimeSeriesSeriesCollection,
  createTheme,
  FieldColorModeId,
  FieldConfigOptionsRegistry,
  FieldOverrideContext,
  FieldMatcherID,
  FieldType,
  Labels,
  ReducerID,
} from '@grafana/data';
import {
  AxisColorMode,
  ComparisonOperation,
  GraphDrawStyle,
  GraphGradientMode,
  GraphTransform,
  ScaleDistribution,
} from '@grafana/schema';

import {
  CompactNativeSeriesFlag,
  createCompactNativeRenderPlan,
  hasSameCompactNativeTopology,
} from './compactNativePlan';
import { CompactFieldConfigOptions } from './compactTypes';

const baseOptions: CompactFieldConfigOptions = {
  fieldConfig: { defaults: {}, overrides: [] },
  fieldConfigRegistry: new FieldConfigOptionsRegistry(),
  replaceVariables: (value) => value,
  theme: createTheme(),
  timeZone: 'utc',
};

describe('CompactNativeRenderPlan', () => {
  test('uses typed columns, interns shared records, reuses one scratch target, and retains the response buffer', () => {
    const scratchTargets = new Set<unknown>();
    const registry = new FieldConfigOptionsRegistry(() => [
      compactProperty('unit', 'unit', false, scratchTargets),
      compactProperty('custom.drawStyle', 'drawStyle', true, scratchTargets),
      compactProperty('custom.lineWidth', 'lineWidth', true, scratchTargets),
    ]);
    const { source, getSeries } = columnarSource([
      series('A', 'requests', [1, 2]),
      series('B', 'errors', [3, 4]),
      series('C', 'latency', [5, 6]),
    ]);

    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: registry,
      fieldConfig: {
        defaults: { unit: 'ms', custom: { drawStyle: GraphDrawStyle.Line, lineWidth: 1 } },
        overrides: [
          {
            matcher: { id: FieldMatcherID.byFrameRefID, options: 'B' },
            properties: [{ id: 'custom.lineWidth', value: 2 }],
          },
        ],
      },
    });

    expect([...plan.columns.configIds]).toEqual([0, 1, 0]);
    expect(plan.source.columns.stackGroupIds).toBeUndefined();
    expect(plan.styles).toHaveLength(2);
    expect(plan.scales).toHaveLength(1);
    expect(plan.getStyle(1).config.custom?.lineWidth).toBe(2);
    expect(plan.getScale(0).config.unit).toBe('ms');
    expect(scratchTargets.size).toBe(1);
    expect(plan.source.buffer).toBe(source.buffer);
    expect(plan.data).toBe(source);
    expect(plan).not.toHaveProperty('series');
    expect(getSeries).not.toHaveBeenCalled();
  });

  test('matches refIds, label-derived names, regexes, and values without materializing series records', () => {
    const registry = new FieldConfigOptionsRegistry(() => [
      compactProperty('custom.drawStyle', 'drawStyle', true),
      compactProperty('custom.lineWidth', 'lineWidth', true),
      compactProperty('custom.transform', 'transform', true),
      compactProperty('custom.spanNulls', 'spanNulls', true),
    ]);
    const { source, getSeries } = columnarSource([
      series('A', 'requests', [1, 2, 3], { region: 'region-a' }),
      series('B', 'errors', [10, 20, 30], { region: 'region-b' }),
    ]);

    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: registry,
      fieldConfig: {
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.byFrameRefID, options: 'B' },
            properties: [{ id: 'custom.drawStyle', value: GraphDrawStyle.Points }],
          },
          {
            matcher: { id: FieldMatcherID.byName, options: 'requests region-a' },
            properties: [{ id: 'custom.lineWidth', value: 5 }],
          },
          {
            matcher: { id: FieldMatcherID.byRegexp, options: '/region-b/' },
            properties: [{ id: 'custom.transform', value: GraphTransform.NegativeY }],
          },
          {
            matcher: {
              id: FieldMatcherID.byValue,
              options: { reducer: ReducerID.countAll, op: ComparisonOperation.GT, value: 2 },
            },
            properties: [{ id: 'custom.spanNulls', value: true }],
          },
        ],
      },
    });

    expect(plan.getStyle(0).config.custom).toMatchObject({ lineWidth: 5, spanNulls: true });
    expect(plan.getStyle(1).config.custom).toMatchObject({
      drawStyle: GraphDrawStyle.Points,
      transform: GraphTransform.NegativeY,
      spanNulls: true,
    });
    expect(plan.columns.flags[1] & CompactNativeSeriesFlag.NegativeY).toBeTruthy();
    expect(plan.getDisplayName(0)).toBe('requests region-a');
    expect(plan.getLabels(1)).toEqual({ region: 'region-b' });
    expect(plan.source.yAt(1, 0)).toBe(-10);
    expect(getSeries).not.toHaveBeenCalled();
  });

  test('uses an exact and stable topology key for configuration reuse', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);
    const fieldConfigRegistry = new FieldConfigOptionsRegistry(() => [
      compactProperty('custom.axisLabel', 'axisLabel', true),
    ]);
    const first = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry,
      fieldConfig: { defaults: { custom: { axisLabel: 'latency' } }, overrides: [] },
    });
    const equivalent = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry,
      fieldConfig: { defaults: { custom: { axisLabel: 'latency' } }, overrides: [] },
    });
    const changed = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry,
      fieldConfig: { defaults: { custom: { axisLabel: 'duration' } }, overrides: [] },
    });

    expect(hasSameCompactNativeTopology(equivalent, first)).toBe(true);
    expect(hasSameCompactNativeTopology(changed, first)).toBe(false);
  });

  test('rejects malformed value matcher options at the descriptor boundary', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2, 3])]);

    expect(() =>
      createCompactNativeRenderPlan(source, {
        ...baseOptions,
        fieldConfig: {
          defaults: {},
          overrides: [
            {
              matcher: { id: FieldMatcherID.byValue, options: { reducer: ReducerID.last, op: 'unknown', value: 1 } },
              properties: [],
            },
          ],
        },
      })
    ).toThrow('supported comparison operation');
  });

  test('does not multiply compact styles for legacy-inert properties', () => {
    const registry = new FieldConfigOptionsRegistry(() => [
      compactProperty('custom.fillColor', 'fillColor', true),
      compactProperty('custom.barWidthFactor', 'barWidthFactor', true),
    ]);
    const { source } = columnarSource([series('A', 'requests', [1]), series('B', 'errors', [2])]);

    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: registry,
      fieldConfig: {
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.byFrameRefID, options: 'B' },
            properties: [
              { id: 'custom.fillColor', value: '#00ff00' },
              { id: 'custom.barWidthFactor', value: 0.2 },
            ],
          },
        ],
      },
    });

    expect(plan.styles).toHaveLength(1);
    expect(plan.getStyle(1).config.custom?.fillColor).toBeUndefined();
  });

  test('keeps labels and displays lazy and shares display processors by interned configuration', () => {
    const labelReads = jest.fn();
    const { source } = columnarSource(
      [
        series('A', 'requests', [1, 2], { region: 'region-a' }),
        series('B', 'requests', [3, 4], { region: 'region-a' }),
      ],
      labelReads
    );
    const plan = createCompactNativeRenderPlan(source, baseOptions);

    const readsDuringColorCompilation = labelReads.mock.calls.length;
    expect(plan.getLabels(0)).toEqual({ region: 'region-a' });
    expect(labelReads.mock.calls.length).toBeGreaterThan(readsDuringColorCompilation);

    labelReads.mockClear();
    expect(plan.getDisplayName(0)).toBe('requests region-a');
    expect(labelReads).toHaveBeenCalled();
    expect(plan.getDisplay(0)).toBe(plan.getDisplay(1));
  });

  test('reduces packed gapped values directly and caches only requested reducer columns', () => {
    const { source, getSeries } = columnarSource([
      series('A', 'requests', [0, 4], undefined, new Uint8Array([0b00000101]), 3),
    ]);
    const plan = createCompactNativeRenderPlan(source, baseOptions);

    expect(plan.columns.flags[0] & CompactNativeSeriesFlag.HasGaps).toBeTruthy();
    expect(plan.reduce(0, ReducerID.countAll)).toBe(3);
    expect(plan.reduce(0, ReducerID.count)).toBe(2);
    expect(plan.reduce(0, ReducerID.sum)).toBe(4);
    expect(plan.reduce(0, ReducerID.first)).toBe(0);
    expect(plan.reduce(0, ReducerID.last)).toBe(4);
    expect(plan.reduce(0, ReducerID.allIsZero)).toBe(false);
    expect(() => plan.reduce(0, ReducerID.median)).toThrow('unsupported');
    expect(getSeries).not.toHaveBeenCalled();
  });

  test('uses positive-only extents for logarithmic scales', () => {
    const { source } = columnarSource([series('A', 'requests', [-1, 0, 10])]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.scaleDistribution', 'scaleDistribution', true),
      ]),
      fieldConfig: {
        defaults: { custom: { scaleDistribution: { type: ScaleDistribution.Log, log: 10 } } },
        overrides: [],
      },
    });

    expect(plan.source.scales[0].mode).toBe('positive');
    expect(plan.source.extent(0, 0, 2, plan.source.scales[0].mode)).toEqual([10, 10]);
  });

  test('compiles area fill independently from line width and point color', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.fillOpacity', 'fillOpacity', true),
        compactProperty('custom.lineWidth', 'lineWidth', true),
      ]),
      fieldConfig: { defaults: { custom: { fillOpacity: 35, lineWidth: 0 } }, overrides: [] },
    });

    const style = plan.source.styles[0];
    expect(style.areaFill).toBe(colorManipulator.alpha(style.stroke, 0.35));
    expect(style.fill).toBe(style.stroke);
    expect(style.lineWidth).toBe(0);
  });

  test('keeps calculated series color separate from explicit line color and legacy-inert options', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);
    const baseline = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.axisColorMode', 'axisColorMode', true),
      ]),
      fieldConfig: {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassicByName },
          custom: { axisColorMode: AxisColorMode.Series },
        },
        overrides: [],
      },
    });
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.axisColorMode', 'axisColorMode', true),
        compactProperty('custom.lineColor', 'lineColor', true),
        compactProperty('custom.fillColor', 'fillColor', true),
        compactProperty('custom.pointColor', 'pointColor', true),
        compactProperty('custom.pointSymbol', 'pointSymbol', true),
      ]),
      fieldConfig: {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassicByName },
          custom: {
            axisColorMode: AxisColorMode.Series,
            lineColor: '#abcdef',
            fillColor: 'ignored-fill',
            pointColor: 'ignored-point',
            pointSymbol: 'ignored-symbol',
          },
        },
        overrides: [],
      },
    });

    expect(plan.source.styles[0]).toEqual(expect.objectContaining({ stroke: '#abcdef', fill: '#abcdef' }));
    expect(plan.source.scales[0].axisColor).toBe(baseline.source.styles[0].stroke);
    expect(plan.source.scales[0].axisColor).not.toBe('#abcdef');
  });

  test('compiles opacity gradients, disconnect thresholds, and lazy value formatting', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.gradientMode', 'gradientMode', true),
        compactProperty('custom.fillOpacity', 'fillOpacity', true),
        compactProperty('custom.insertNulls', 'insertNulls', true),
        compactProperty('custom.showValues', 'showValues', true),
        compactProperty('unit', 'unit', false),
      ]),
      fieldConfig: {
        defaults: {
          unit: 'ms',
          custom: {
            gradientMode: GraphGradientMode.Opacity,
            fillOpacity: 20,
            insertNulls: 60_000,
            showValues: true,
          },
        },
        overrides: [],
      },
    });

    const style = plan.source.styles[0];
    expect(style.areaFill).toBeUndefined();
    expect(style.areaGradient).toEqual([
      colorManipulator.alpha(style.stroke, 0.2),
      colorManipulator.alpha(style.stroke, 0),
    ]);
    expect(style.disconnectThreshold).toBe(60_000);
    expect(style.showValues).toBe(true);
    expect(plan.source.formatValueAt?.(0, 0, 1)).toContain('ms');
  });

  test.each([
    { lineStyle: undefined, dash: [], cap: 'butt' },
    { lineStyle: { fill: 'solid', dash: [3, 4] }, dash: [], cap: 'butt' },
    { lineStyle: { fill: 'dash' }, dash: [10, 10], cap: 'butt' },
    { lineStyle: { fill: 'dash', dash: null }, dash: [10, 10], cap: 'butt' },
    { lineStyle: { fill: 'dash', dash: [] }, dash: [], cap: 'butt' },
    { lineStyle: { fill: 'dot', dash: [2, 5] }, dash: [2, 5], cap: 'round' },
    { lineStyle: { fill: 'square' }, dash: [10, 10], cap: 'butt' },
    { lineStyle: { dash: [4, 2] }, dash: [4, 2], cap: 'butt' },
  ] as const)('normalizes compact line style semantics: %p', ({ lineStyle, dash, cap }) => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.lineStyle', 'lineStyle', true),
      ]),
      fieldConfig: { defaults: { custom: { lineStyle: lineStyle as never } }, overrides: [] },
    });

    expect(plan.source.styles[0]).toEqual(expect.objectContaining({ lineDash: dash, lineCap: cap }));
  });

  test('keeps palette-by-name colors stable across response ordering', () => {
    const options: CompactFieldConfigOptions = {
      ...baseOptions,
      fieldConfig: { defaults: { color: { mode: FieldColorModeId.PaletteClassicByName } }, overrides: [] },
    };
    const first = createCompactNativeRenderPlan(
      columnarSource([series('A', 'requests', [1]), series('B', 'errors', [2])]).source,
      options
    );
    const second = createCompactNativeRenderPlan(
      columnarSource([series('B', 'errors', [2]), series('A', 'requests', [1])]).source,
      options
    );
    const colors = (plan: ReturnType<typeof createCompactNativeRenderPlan>) =>
      new Map(
        Array.from({ length: plan.seriesCount }, (_, index) => [
          plan.getDisplayName(index),
          plan.source.styles[plan.source.columns.styleIds[index]].stroke,
        ])
      );

    expect(colors(second)).toEqual(colors(first));
  });

  test('applies compact palette and style overrides only to matching descriptors', () => {
    const { source } = columnarSource([series('A', 'requests', [1]), series('B', 'errors', [2])]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.fillOpacity', 'fillOpacity', true),
        compactProperty('custom.lineStyle', 'lineStyle', true),
        compactProperty('custom.lineWidth', 'lineWidth', true),
      ]),
      fieldConfig: {
        defaults: { color: { mode: FieldColorModeId.PaletteClassicByName } },
        overrides: [
          {
            matcher: { id: FieldMatcherID.byFrameRefID, options: 'B' },
            properties: [
              { id: 'custom.fillOpacity', value: 35 },
              { id: 'custom.lineStyle', value: { fill: 'dot' } },
              { id: 'custom.lineWidth', value: 0 },
            ],
          },
        ],
      },
    });

    const requests = plan.source.styles[plan.source.columns.styleIds[0]];
    const errors = plan.source.styles[plan.source.columns.styleIds[1]];
    expect(requests).toEqual(expect.objectContaining({ areaFill: undefined, lineDash: [], lineCap: 'butt' }));
    expect(errors).toEqual(
      expect.objectContaining({
        areaFill: colorManipulator.alpha(errors.stroke, 0.35),
        lineDash: [10, 10],
        lineCap: 'round',
        lineWidth: 0,
      })
    );
  });

  test.each([
    { fillOpacity: -1 },
    { fillOpacity: 101 },
    { lineStyle: { fill: 'dash', dash: [0, 0] } },
    { lineStyle: { fill: 'dot', dash: [-1, 2] } },
    { lineColor: 'not-a-color' },
    { insertNulls: true },
    { spanNulls: -2 },
  ])('rejects direct compact callers that bypass admission: %p', (custom) => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);
    const registry = new FieldConfigOptionsRegistry(() =>
      Object.keys(custom).map((property) => compactProperty(`custom.${property}`, property, true))
    );

    expect(() =>
      createCompactNativeRenderPlan(source, {
        ...baseOptions,
        fieldConfigRegistry: registry,
        fieldConfig: { defaults: { custom: custom as never }, overrides: [] },
      })
    ).toThrow('Compact rendering');
  });

  test('rejects mixed insertNulls thresholds for direct compact callers', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);

    expect(() =>
      createCompactNativeRenderPlan(source, {
        ...baseOptions,
        fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
          compactProperty('custom.insertNulls', 'insertNulls', true),
        ]),
        fieldConfig: {
          defaults: { custom: { insertNulls: 60_000 } },
          overrides: [
            {
              matcher: { id: FieldMatcherID.byName, options: 'requests' },
              properties: [{ id: 'custom.insertNulls', value: 300_000 }],
            },
          ],
        },
      })
    ).toThrow('one insertNulls threshold');
  });
});

function compactProperty(id: string, path: string, isCustom: boolean, targets?: Set<unknown>) {
  return {
    id,
    path,
    name: id,
    isCustom,
    editor: () => null,
    override: () => null,
    process: (value: unknown, context: FieldOverrideContext) => {
      if (targets && context.target) {
        targets.add(context.target.config);
      }
      return value;
    },
    shouldApply: (target: { type: FieldType }) => target.type === FieldType.number,
  };
}

interface TestSeries {
  refId: string;
  valueName: string;
  values: number[];
  labels: Labels;
  presence?: Uint8Array;
  axisCount: number;
}

function series(
  refId: string,
  valueName: string,
  values: number[],
  labels: Labels = {},
  presence?: Uint8Array,
  axisCount = values.length
): TestSeries {
  return { refId, valueName, values, labels, presence, axisCount };
}

function columnarSource(definitions: TestSeries[], onLabelRead: jest.Mock = jest.fn()) {
  const valueBytes = definitions.reduce((total, definition) => total + definition.values.length * 8, 0);
  const presenceBytes = definitions.reduce((total, definition) => total + (definition.presence?.byteLength ?? 0), 0);
  const buffer = new ArrayBuffer(valueBytes + presenceBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const length = definitions.length;
  const columns = {
    refIdStringIds: new Uint32Array(length),
    frameNameStringIds: new Uint32Array(length),
    valueNameStringIds: new Uint32Array(length),
    displayNameStringIds: new Uint32Array(length),
    metaIds: new Uint32Array(length),
    axisIds: new Uint32Array(length),
    labelRecordsOffsets: new Uint32Array(length),
    labelCounts: new Uint32Array(length),
    presenceByteOffsets: new Uint32Array(length),
    presenceByteLengths: new Uint32Array(length),
    presentCounts: new Uint32Array(length),
    valuesByteOffsets: new Uint32Array(length),
  };
  let valueOffset = 0;
  let presenceOffset = valueBytes;
  for (let index = 0; index < length; index++) {
    const definition = definitions[index];
    columns.labelCounts[index] = Object.keys(definition.labels).length;
    columns.presentCounts[index] = definition.values.length;
    columns.valuesByteOffsets[index] = valueOffset;
    for (const value of definition.values) {
      view.setFloat64(valueOffset, value, true);
      valueOffset += 8;
    }
    if (definition.presence) {
      columns.presenceByteOffsets[index] = presenceOffset;
      columns.presenceByteLengths[index] = definition.presence.byteLength;
      bytes.set(definition.presence, presenceOffset);
      presenceOffset += definition.presence.byteLength;
    }
  }

  const getSeries = jest.fn(() => {
    throw new Error('series records must not be materialized');
  });
  const collection = {
    length,
    columns,
    get: getSeries,
    getRefId: (index: number) => definitions[index].refId,
    getFrameName: () => undefined,
    getValueName: (index: number) => definitions[index].valueName,
    getDisplayNameFromDS: () => undefined,
    getMeta: () => ({}),
    getLabel: (index: number, name: string) => {
      onLabelRead();
      return definitions[index].labels[name];
    },
    forEachLabel: (index: number, callback: (name: string, value: string) => void) => {
      onLabelRead();
      for (const [name, value] of Object.entries(definitions[index].labels)) {
        callback(name, value);
      }
    },
    getSharedLabelName: () => {
      const names = new Set(definitions.flatMap((definition) => Object.keys(definition.labels)));
      return names.size === 1 ? (names.values().next().value ?? null) : null;
    },
    getIdentityHash: (index: number) => index,
    resolveColumnIndex: (index: number) => index,
  } as unknown as CompactTimeSeriesSeriesCollection;

  const source: CompactTimeSeriesData = {
    kind: 'compact-response-view',
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer,
    axes: [{ start: 1_000, step: 1_000, count: Math.max(0, ...definitions.map((item) => item.axisCount)) }],
    series: collection,
    metadata: {
      getLabel: () => {
        throw new Error('columnar metadata must be read by index');
      },
      forEachLabel: () => {
        throw new Error('columnar metadata must be read by index');
      },
      materializeLabels: () => {
        throw new Error('labels must stay lazy');
      },
    },
    decodeStats: {
      responseBytes: buffer.byteLength,
      axisCount: 1,
      resultCount: 1,
      stringCount: 0,
      stringBytes: 0,
      seriesCount: length,
    },
  };

  return { source, getSeries };
}
