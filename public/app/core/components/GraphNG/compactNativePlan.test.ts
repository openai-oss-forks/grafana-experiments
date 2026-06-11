import {
  colorManipulator,
  COMPACT_TIME_SERIES_FORMAT,
  CompactTimeSeriesData,
  CompactTimeSeriesSeriesCollection,
  createTheme,
  Field,
  FieldColorModeId,
  FieldConfigOptionsRegistry,
  FieldOverrideContext,
  FieldMatcherID,
  FieldType,
  getFieldSeriesColor,
  Labels,
  NullValueMode,
  ReducerID,
  reduceField,
} from '@grafana/data';
import {
  AxisColorMode,
  ComparisonOperation,
  GraphDrawStyle,
  GraphGradientMode,
  GraphTransform,
  ScaleDistribution,
  StackingMode,
} from '@grafana/schema';
import { CompactSeriesFlag } from '@grafana/ui/internal';

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
  test('disables hover highlighting without disabling compact cursor selection', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2]), series('A', 'errors', [2, 1])]);

    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      cursorMode: 'single',
      highlightSeriesOnHover: false,
    });

    expect(plan.source.cursorMode).toBe('single');
    expect(plan.source.focusOverlayColor).toBeUndefined();
  });

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

  test('keeps per-series variable configuration on the descriptor path', () => {
    const displayName = {
      ...compactProperty('displayName', 'displayName', false),
      process: (value: unknown, context: FieldOverrideContext) => context.replaceVariables!(String(value)),
    };
    const { source } = columnarSource([
      series('A', 'requests', [1], { region: 'east' }),
      series('A', 'requests', [2], { region: 'west' }),
    ]);

    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [displayName]),
      fieldConfig: {
        defaults: { displayName: '${__field.labels.region}' },
        overrides: [],
      },
    });

    expect(plan.getDisplayName(0)).toBe('east');
    expect(plan.getDisplayName(1)).toBe('west');
  });

  test('does not reuse context-sensitive field processor results across series', () => {
    const displayName = {
      ...compactProperty('displayName', 'displayName', false),
      process: (_value: unknown, context: FieldOverrideContext) => context.target!.name,
    };
    const { source } = columnarSource([series('A', 'requests-east', [1]), series('A', 'requests-west', [2])]);

    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [displayName]),
      fieldConfig: {
        defaults: { displayName: 'unused' },
        overrides: [],
      },
    });

    expect(plan.getDisplayName(0)).toBe('requests-east');
    expect(plan.getDisplayName(1)).toBe('requests-west');
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

  test('evaluates value matchers against returned rows rather than synthetic axis gaps', () => {
    const registry = new FieldConfigOptionsRegistry(() => [
      compactProperty('nullValueMode', 'nullValueMode', false),
      compactProperty('custom.lineWidth', 'lineWidth', true),
      compactProperty('custom.transform', 'transform', true),
    ]);
    const { source } = columnarSource([series('A', 'requests', [4, 8], undefined, new Uint8Array([0b00000101]), 3)]);

    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: registry,
      fieldConfig: {
        defaults: { nullValueMode: NullValueMode.AsZero, custom: { lineWidth: 1 } },
        overrides: [
          {
            matcher: {
              id: FieldMatcherID.byValue,
              options: { reducer: ReducerID.countAll, op: ComparisonOperation.EQ, value: 2 },
            },
            properties: [{ id: 'custom.lineWidth', value: 2 }],
          },
          {
            matcher: {
              id: FieldMatcherID.byValue,
              options: { reducer: ReducerID.min, op: ComparisonOperation.EQ, value: 0 },
            },
            properties: [{ id: 'custom.transform', value: GraphTransform.NegativeY }],
          },
        ],
      },
    });

    expect(plan.getStyle(0).config.custom).toMatchObject({ lineWidth: 2 });
    expect(plan.getStyle(0).config.custom?.transform).toBeUndefined();
  });

  test('calculates by-value color ranges from returned rows before graph gap insertion', () => {
    const config = {
      color: { mode: FieldColorModeId.ContinuousGrYlRd, seriesBy: 'last' as const },
      nullValueMode: NullValueMode.AsZero,
    };
    const { source } = columnarSource([series('A', 'requests', [4, 6, 5], undefined, new Uint8Array([0b00001101]), 4)]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('color', 'color', false),
        compactProperty('nullValueMode', 'nullValueMode', false),
      ]),
      fieldConfig: { defaults: config, overrides: [] },
    });
    const legacyField: Field = {
      name: 'requests',
      type: FieldType.number,
      config,
      values: [4, null, 6, 5],
      state: { range: { min: 4, max: 6, delta: 2 } },
    };

    expect(plan.source.styles[0].stroke).toBe(getFieldSeriesColor(legacyField, baseOptions.theme).color);
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
    expect(plan.reduce(0, ReducerID.median)).toBe(2);
    expect(getSeries).not.toHaveBeenCalled();
  });

  test.each([
    [NullValueMode.Ignore, [3, null, 2, 1, 4]],
    [NullValueMode.Null, [3, null, 2, 1, 4]],
    [NullValueMode.AsZero, [3, null, 2, 1, 4]],
    [NullValueMode.Null, [0, null, 1]],
    [NullValueMode.Null, [null, 0, 1]],
    [NullValueMode.Null, [null, null]],
    [NullValueMode.Ignore, [null, null, null]],
    [NullValueMode.Null, [null, null, null]],
    [NullValueMode.AsZero, [null, null, null]],
    [NullValueMode.Ignore, [-5, -1, 0, 7]],
    [NullValueMode.Ignore, [2, 2, 2, 9]],
    [NullValueMode.Ignore, [7]],
    [NullValueMode.Ignore, []],
    [NullValueMode.Ignore, [1, Number.NaN, Number.POSITIVE_INFINITY, 3]],
    [NullValueMode.Null, [1, Number.NaN, Number.POSITIVE_INFINITY, 3]],
    [NullValueMode.AsZero, [1, Number.NaN, Number.POSITIVE_INFINITY, 3]],
  ] as Array<[NullValueMode, Array<number | null>]>)(
    'matches the legacy median for null mode %s and values %p',
    (nullValueMode, values) => {
      const compactValues = values.map((value) => (value != null && Number.isFinite(value) ? value : null));
      const { source, getSeries } = columnarSource([seriesFromLogicalValues('A', 'requests', values)]);
      const plan = createCompactNativeRenderPlan(source, {
        ...baseOptions,
        fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
          compactProperty('nullValueMode', 'nullValueMode', false),
        ]),
        fieldConfig: { defaults: { nullValueMode }, overrides: [] },
      });
      const legacyField: Field<number | null> = {
        name: 'requests',
        type: FieldType.number,
        config: { nullValueMode },
        values: compactValues,
      };
      const expected = reduceField({ field: legacyField, reducers: [ReducerID.median] }).median;

      expect(Object.is(plan.reduce(0, ReducerID.median), expected)).toBe(true);
      expect(plan.source.buffer).toBe(source.buffer);
      expect(getSeries).not.toHaveBeenCalled();
    }
  );

  test('reuses exact median results across ordered value matchers and by-value colors', () => {
    const registry = new FieldConfigOptionsRegistry(() => [
      compactProperty('color', 'color', false),
      compactProperty('nullValueMode', 'nullValueMode', false),
      compactProperty('custom.lineWidth', 'lineWidth', true),
    ]);
    const { source, getSeries } = columnarSource([
      series('A', 'requests', [Number.NaN, 4, 8]),
      series('B', 'requests', [1, 100, 3]),
    ]);
    const color = { mode: FieldColorModeId.ContinuousGrYlRd };
    Reflect.set(color, 'seriesBy', ReducerID.median);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: registry,
      fieldConfig: {
        defaults: {
          color,
          custom: { lineWidth: 1 },
        },
        overrides: [
          {
            matcher: {
              id: FieldMatcherID.byValue,
              options: { reducer: ReducerID.median, op: ComparisonOperation.EQ, value: 6 },
            },
            properties: [{ id: 'nullValueMode', value: NullValueMode.AsZero }],
          },
          {
            matcher: {
              id: FieldMatcherID.byValue,
              options: { reducer: ReducerID.median, op: ComparisonOperation.EQ, value: 4 },
            },
            properties: [{ id: 'custom.lineWidth', value: 2 }],
          },
        ],
      },
    });
    const legacyColor = { mode: FieldColorModeId.ContinuousGrYlRd };
    Reflect.set(legacyColor, 'seriesBy', ReducerID.median);
    const legacyField: Field = {
      name: 'requests',
      type: FieldType.number,
      config: {
        color: legacyColor,
      },
      values: [1, 100, 3],
      state: { range: { min: 1, max: 100, delta: 99 } },
    };

    expect(plan.getStyle(0).config).toMatchObject({
      nullValueMode: NullValueMode.AsZero,
      custom: { lineWidth: 2 },
    });
    expect(plan.reduce(0, ReducerID.median)).toBe(4);
    expect(plan.reduce(1, ReducerID.median)).toBe(3);
    expect(plan.source.styles[plan.source.columns.styleIds[1]].stroke).toBe(
      getFieldSeriesColor(legacyField, baseOptions.theme).color
    );
    expect(getSeries).not.toHaveBeenCalled();
  });

  test('preserves null-mode semantics when min and max share one cached scan', () => {
    const { source } = columnarSource([series('A', 'requests', [4, 8], undefined, new Uint8Array([0b00000101]), 3)]);
    const ignored = createCompactNativeRenderPlan(source, baseOptions);
    const zeroFilled = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('nullValueMode', 'nullValueMode', false),
      ]),
      fieldConfig: {
        defaults: { nullValueMode: NullValueMode.AsZero },
        overrides: [],
      },
    });

    expect([ignored.reduce(0, ReducerID.min), ignored.reduce(0, ReducerID.max)]).toEqual([4, 8]);
    expect([zeroFilled.reduce(0, ReducerID.min), zeroFilled.reduce(0, ReducerID.max)]).toEqual([0, 8]);
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
    expect(style.cursorStroke).toBe(colorManipulator.alpha(style.stroke, 0.5));
    expect(style.fill).toBe(style.stroke);
    expect(style.lineWidth).toBe(0);
  });

  test('normalizes the legacy sqrt scale value to linear', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2])]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.scaleDistribution', 'scaleDistribution', true),
      ]),
      fieldConfig: {
        defaults: { custom: { scaleDistribution: { type: 'sqrt' as ScaleDistribution } } },
        overrides: [],
      },
    });

    expect(plan.source.scales[0].distribution).toBe(ScaleDistribution.Linear);
  });

  test('compiles normal stacks into stable groups without materializing sample arrays', () => {
    const { source, getSeries } = columnarSource([
      series('A', 'requests', [1, 2, 3]),
      series('B', 'errors', [4, 5, 6]),
      series('C', 'decrements', [-1, -2, -3]),
      series('D', 'other', [7, 8, 9]),
    ]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [compactProperty('custom.stacking', 'stacking', true)]),
      fieldConfig: {
        defaults: { custom: { stacking: { mode: StackingMode.Normal, group: 'primary' } } },
        overrides: [
          {
            matcher: { id: FieldMatcherID.byFrameRefID, options: 'D' },
            properties: [{ id: 'custom.stacking', value: { mode: StackingMode.Normal, group: 'other' } }],
          },
        ],
      },
    });

    expect(plan.source.stackGroupCount).toBe(1);
    expect(plan.source.columns.stackGroupIds).toEqual(new Uint8Array([1, 1, 0, 0]));
    expect(Array.from(plan.source.columns.flags, (flags) => (flags & CompactSeriesFlag.Stack) !== 0)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(plan.source.buffer).toBe(source.buffer);
    expect(getSeries).not.toHaveBeenCalled();
  });

  test('uses the original value direction for negative and constant transforms', () => {
    const { source } = columnarSource([
      series('A', 'positive', [1, 2, 3]),
      series('B', 'negative-rendered-positive', [-1, -2, -3]),
      series('C', 'constant-positive', [4, 5, 6]),
    ]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [
        compactProperty('custom.stacking', 'stacking', true),
        compactProperty('custom.transform', 'transform', true),
      ]),
      fieldConfig: {
        defaults: { custom: { stacking: { mode: StackingMode.Normal, group: 'primary' } } },
        overrides: [
          {
            matcher: { id: FieldMatcherID.byFrameRefID, options: 'B' },
            properties: [{ id: 'custom.transform', value: GraphTransform.NegativeY }],
          },
          {
            matcher: { id: FieldMatcherID.byFrameRefID, options: 'C' },
            properties: [{ id: 'custom.transform', value: GraphTransform.Constant }],
          },
        ],
      },
    });

    expect(plan.source.stackGroupCount).toBe(1);
    expect(plan.source.columns.stackGroupIds).toEqual(new Uint8Array([1, 1, 1]));
  });

  test('does not allocate stack state for singleton groups', () => {
    const { source } = columnarSource([series('A', 'requests', [1, 2, 3])]);
    const plan = createCompactNativeRenderPlan(source, {
      ...baseOptions,
      fieldConfigRegistry: new FieldConfigOptionsRegistry(() => [compactProperty('custom.stacking', 'stacking', true)]),
      fieldConfig: {
        defaults: { custom: { stacking: { mode: StackingMode.Normal, group: 'primary' } } },
        overrides: [],
      },
    });

    expect(plan.source.stackGroupCount).toBe(0);
    expect(plan.source.columns.stackGroupIds).toBeUndefined();
    expect(plan.source.columns.flags[0] & CompactSeriesFlag.Stack).toBe(0);
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

function seriesFromLogicalValues(
  refId: string,
  valueName: string,
  logicalValues: Array<number | null>,
  labels: Labels = {}
): TestSeries {
  const values: number[] = [];
  const hasGaps = logicalValues.some((value) => value == null);
  const presence = hasGaps ? new Uint8Array(Math.ceil(logicalValues.length / 8)) : undefined;

  for (let index = 0; index < logicalValues.length; index++) {
    const value = logicalValues[index];
    if (value == null) {
      continue;
    }
    values.push(value);
    if (presence) {
      presence[index >> 3] |= 1 << (index & 7);
    }
  }

  return series(refId, valueName, values, labels, presence, logicalValues.length);
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
