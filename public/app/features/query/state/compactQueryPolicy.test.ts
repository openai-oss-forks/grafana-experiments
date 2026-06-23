import {
  CoreApp,
  FieldColorModeId,
  FieldConfigProperty,
  FieldConfigSource,
  FieldMatcherID,
  ReducerID,
} from '@grafana/data';
import { config } from '@grafana/runtime';
import {
  AxisColorMode,
  AxisPlacement,
  BarAlignment,
  ComparisonOperation,
  GraphDrawStyle,
  GraphGradientMode,
  GraphTransform,
  LineInterpolation,
  ScaleDistribution,
  SortOrder,
  StackingMode,
  VizOrientation,
} from '@grafana/schema';

import { getPreferredDashboardQueryFormat } from './compactQueryPolicy';

describe('compact dashboard query policy', () => {
  test('opts in only a dashboard timeseries view without transformations', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        transformations: [],
      })
    ).toBe('compact-v1');
  });

  test.each(['queryServiceRewrite', 'queryServiceFromUI'] as const)(
    'leaves %s routing to the transport layer',
    (featureToggle) => {
      const previous = config.featureToggles[featureToggle];
      config.featureToggles[featureToggle] = true;
      try {
        expect(getPreferredDashboardQueryFormat({ app: CoreApp.Dashboard, panelPluginId: 'timeseries' })).toBe(
          'compact-v1'
        );
      } finally {
        config.featureToggles[featureToggle] = previous;
      }
    }
  );

  test.each([
    { app: CoreApp.Explore, panelPluginId: 'timeseries' },
    { app: CoreApp.Dashboard, panelPluginId: 'table' },
    { app: CoreApp.Dashboard, panelPluginId: 'timeseries', isInspecting: true },
    { app: CoreApp.Dashboard, panelPluginId: 'timeseries', isPublicDashboard: true },
    { app: CoreApp.Dashboard, panelPluginId: 'timeseries', hasTimeComparison: true },
    { app: CoreApp.Dashboard, panelPluginId: 'timeseries', panelOptions: { orientation: VizOrientation.Vertical } },
    { app: CoreApp.Dashboard, panelPluginId: 'timeseries', transformations: [{ id: 'reduce' }] },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: {
        defaults: {},
        overrides: [{ matcher: { id: 'plugin-custom-matcher', options: {} }, properties: [] }],
      },
    },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: { defaults: { custom: { lineInterpolation: LineInterpolation.Smooth } }, overrides: [] },
    },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: { defaults: { custom: { stacking: { mode: StackingMode.Percent, group: 'A' } } }, overrides: [] },
    },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: { defaults: { custom: { futureRendererOption: true } }, overrides: [] },
    },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: { defaults: { links: [{ title: 'details', url: '/' }] }, overrides: [] },
    },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: {
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.byName, options: 'requests' },
            properties: [{ id: FieldConfigProperty.Links, value: [{ title: 'details', url: '/' }] }],
          },
        ],
      },
    },
  ])('keeps unsupported request context on JSON: %p', (context) => {
    expect(getPreferredDashboardQueryFormat(context)).toBeUndefined();
  });

  test('supports median in legends, value matchers, and color reducers', () => {
    const fieldConfig: FieldConfigSource = {
      defaults: { color: { mode: 'continuous-blues' } },
      overrides: [
        {
          matcher: {
            id: FieldMatcherID.byValue,
            options: { reducer: ReducerID.median, value: 10 },
          },
          properties: [],
        },
      ],
    };
    Reflect.set(fieldConfig.defaults.color!, 'seriesBy', ReducerID.median);

    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        legendCalcs: [ReducerID.median],
        fieldConfig,
      })
    ).toBe('compact-v1');
  });

  test('supports normal line stacking without leaving the compact path', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: {
            custom: {
              drawStyle: GraphDrawStyle.Line,
              stacking: { mode: StackingMode.Normal, group: 'A' },
            },
          },
          overrides: [],
        },
      })
    ).toBe('compact-v1');
  });

  test('supports constant-transformed normal stacks', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: {
            custom: {
              stacking: { mode: StackingMode.Normal, group: 'A' },
              transform: GraphTransform.Constant,
            },
          },
          overrides: [],
        },
      })
    ).toBe('compact-v1');
  });

  test('rejects unsupported percentile color reducers from runtime dashboard JSON', () => {
    const fieldConfig: FieldConfigSource = {
      defaults: { color: { mode: 'continuous-blues' } },
      overrides: [],
    };
    Reflect.set(fieldConfig.defaults.color!, 'seriesBy', ReducerID.p95);

    expect(
      getPreferredDashboardQueryFormat({ app: CoreApp.Dashboard, panelPluginId: 'timeseries', fieldConfig })
    ).toBeUndefined();
  });

  test('supports frame refId overrides for compact responses', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: {},
          overrides: [{ matcher: { id: FieldMatcherID.byFrameRefID, options: 'A' }, properties: [] }],
        },
      })
    ).toBe('compact-v1');
  });

  test('supports sorted time-series tooltips', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        panelOptions: { tooltip: { sort: SortOrder.Descending } },
      })
    ).toBe('compact-v1');
  });

  test.each([{ fillOpacity: null }, { fillOpacity: 0 }, { fillOpacity: 35 }, { fillOpacity: 100 }])(
    'supports valid fill opacity: %p',
    (custom) => {
      expect(
        getPreferredDashboardQueryFormat({
          app: CoreApp.Dashboard,
          panelPluginId: 'timeseries',
          fieldConfig: { defaults: { custom }, overrides: [] },
        })
      ).toBe('compact-v1');
    }
  );

  test.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY, '35'])(
    'rejects invalid fill opacity: %p',
    (fillOpacity) => {
      expect(
        getPreferredDashboardQueryFormat({
          app: CoreApp.Dashboard,
          panelPluginId: 'timeseries',
          fieldConfig: { defaults: { custom: { fillOpacity } }, overrides: [] },
        })
      ).toBeUndefined();
    }
  );

  test.each([
    undefined,
    null,
    { fill: 'solid', dash: [3, 4] },
    { fill: 'dash' },
    { fill: 'dash', dash: null },
    { fill: 'dash', dash: [] },
    { fill: 'dot', dash: [2, 5] },
    { fill: 'square' },
    { dash: [4, 2] },
  ])('supports compact line style semantics: %p', (lineStyle) => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: { defaults: { custom: { lineStyle } }, overrides: [] },
      })
    ).toBe('compact-v1');
  });

  test.each([
    'dash',
    { fill: 'unknown' },
    { fill: 'dash', dash: '4,2' },
    { fill: 'dot', dash: [-1, 2] },
    { fill: 'square', dash: [Number.NaN, 2] },
    { fill: 'dash', dash: [0, 0] },
  ])('rejects malformed compact line styles: %p', (lineStyle) => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: { defaults: { custom: { lineStyle } }, overrides: [] },
      })
    ).toBeUndefined();
  });

  test('supports palette-by-name, line-inert bar settings, and the TimeSeries bar renderer', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: {
            color: { mode: FieldColorModeId.PaletteClassicByName },
            custom: { barAlignment: BarAlignment.After, barMaxWidth: 24 },
          },
          overrides: [
            {
              matcher: { id: FieldMatcherID.byName, options: 'requests' },
              properties: [
                { id: FieldConfigProperty.Color, value: { mode: FieldColorModeId.PaletteClassicByName } },
                { id: 'custom.barAlignment', value: BarAlignment.Before },
                { id: 'custom.barMaxWidth', value: 12 },
              ],
            },
          ],
        },
      })
    ).toBe('compact-v1');

    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: {
            color: { mode: FieldColorModeId.Thresholds },
            custom: { drawStyle: GraphDrawStyle.Bars },
          },
          overrides: [],
        },
      })
    ).toBe('compact-v1');
  });

  test('supports percent stacking for TimeSeries bars without admitting it for lines', () => {
    const stacking = { mode: StackingMode.Percent, group: 'A' };
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: { custom: { drawStyle: GraphDrawStyle.Bars, stacking } },
          overrides: [],
        },
      })
    ).toBe('compact-v1');
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: { custom: { drawStyle: GraphDrawStyle.Line, stacking } },
          overrides: [],
        },
      })
    ).toBeUndefined();
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: { custom: { drawStyle: GraphDrawStyle.Line, stacking } },
          overrides: [
            {
              matcher: { id: FieldMatcherID.byName, options: 'does-not-exist' },
              properties: [{ id: 'custom.drawStyle', value: GraphDrawStyle.Bars }],
            },
          ],
        },
      })
    ).toBeUndefined();
  });

  test('falls back instead of throwing for malformed field configuration', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: { overrides: [{ properties: null }] } as unknown as FieldConfigSource,
      })
    ).toBeUndefined();
    for (const fieldConfig of [
      { defaults: null, overrides: [null] },
      { defaults: {}, overrides: [{ matcher: { id: FieldMatcherID.numeric }, properties: [null] }] },
      { defaults: { unit: 1 }, overrides: [] },
    ]) {
      expect(
        getPreferredDashboardQueryFormat({
          app: CoreApp.Dashboard,
          panelPluginId: 'barchart',
          fieldConfig: fieldConfig as unknown as FieldConfigSource,
          panelOptions: {},
        })
      ).toBeUndefined();
    }
  });

  test('admits the supported standalone time-axis Bar chart subset', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'barchart',
        fieldConfig: {
          defaults: { custom: { drawStyle: GraphDrawStyle.Line, fillOpacity: 80, lineWidth: 1 } },
          overrides: [
            {
              matcher: { id: FieldMatcherID.byName, options: 'requests' },
              properties: [
                { id: 'custom.drawStyle', value: GraphDrawStyle.Line },
                { id: 'custom.showPoints', value: 'sometimes' },
                { id: 'custom.stacking', value: { mode: 'future' } },
              ],
            },
          ],
        },
        legendCalcs: [ReducerID.min, ReducerID.max],
        panelOptions: {
          orientation: VizOrientation.Auto,
          stacking: StackingMode.Percent,
          showValue: 'auto',
          groupWidth: 0.7,
          barWidth: 0.97,
          barRadius: 0.2,
          fullHighlight: true,
          xTickLabelRotation: 0,
          xTickLabelMaxLength: 0,
          xTickLabelSpacing: 0,
        },
      })
    ).toBe('compact-v1');
  });

  test('falls back when standalone field overrides can change the category axis', () => {
    const panelOptions = {
      orientation: VizOrientation.Vertical,
      stacking: StackingMode.None,
      showValue: 'auto',
      groupWidth: 0.7,
      barWidth: 0.97,
      xTickLabelMaxLength: 0,
    };
    const preferredFormat = (fieldConfig: FieldConfigSource) =>
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'barchart',
        fieldConfig,
        panelOptions,
      });

    expect(
      preferredFormat({
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.byName, options: 'Time' },
            properties: [{ id: 'custom.axisPlacement', value: AxisPlacement.Hidden }],
          },
        ],
      })
    ).toBeUndefined();
    expect(
      preferredFormat({
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.byName, options: 'Time' },
            properties: [{ id: 'custom.axisLabel', value: 'Timestamp' }],
          },
        ],
      })
    ).toBeUndefined();
    expect(
      preferredFormat({
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.numeric, options: {} },
            properties: [{ id: 'custom.axisPlacement', value: AxisPlacement.Hidden }],
          },
        ],
      })
    ).toBe('compact-v1');
    expect(preferredFormat({ defaults: { unit: 'time:YYYY-MM-DD' }, overrides: [] })).toBeUndefined();
  });

  test.each([
    { xField: 'category' },
    { colorByField: 'color' },
    { barWidth: 2 },
    { stacking: 'future' },
    { xTickLabelMaxLength: 12 },
  ])('keeps unsupported standalone Bar chart configuration on JSON: %p', (unsupported) => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'barchart',
        fieldConfig: { defaults: {}, overrides: [] },
        panelOptions: {
          orientation: VizOrientation.Vertical,
          stacking: StackingMode.None,
          showValue: 'auto',
          groupWidth: 0.7,
          barWidth: 0.97,
          fullHighlight: false,
          ...unsupported,
        },
      })
    ).toBeUndefined();
  });

  test('treats the legacy sqrt scale value as linear', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: { defaults: { custom: { scaleDistribution: { type: 'sqrt' } } }, overrides: [] },
      })
    ).toBe('compact-v1');
  });

  test('supports opacity gradients and keeps unsupported gradient modes on JSON', () => {
    const context = {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
    } as const;

    expect(
      getPreferredDashboardQueryFormat({
        ...context,
        fieldConfig: {
          defaults: { custom: { gradientMode: GraphGradientMode.Opacity, fillOpacity: 0 } },
          overrides: [],
        },
      })
    ).toBe('compact-v1');
    expect(
      getPreferredDashboardQueryFormat({
        ...context,
        fieldConfig: {
          defaults: { custom: { gradientMode: GraphGradientMode.Opacity, fillOpacity: 20 } },
          overrides: [],
        },
      })
    ).toBe('compact-v1');
    expect(
      getPreferredDashboardQueryFormat({
        ...context,
        fieldConfig: {
          defaults: { custom: { gradientMode: GraphGradientMode.Opacity, fillOpacity: 0 } },
          overrides: [
            {
              matcher: { id: FieldMatcherID.byName, options: 'requests' },
              properties: [{ id: 'custom.fillOpacity', value: 20 }],
            },
          ],
        },
      })
    ).toBe('compact-v1');
    expect(
      getPreferredDashboardQueryFormat({
        ...context,
        fieldConfig: { defaults: { custom: { gradientMode: GraphGradientMode.Hue, fillOpacity: 0 } }, overrides: [] },
      })
    ).toBeUndefined();
  });

  test('admits common compact defaults and legacy-inert TimeSeries options', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        panelOptions: { tooltip: { hideZeros: true } },
        fieldConfig: {
          defaults: {
            custom: {
              axisColorMode: AxisColorMode.Text,
              insertNulls: false,
              lineColor: '#ff0000',
              fillColor: 'not-used-by-timeseries',
              pointColor: 'not-used-by-timeseries',
              pointSymbol: 'triangle',
              showValues: true,
              spanNulls: -1,
            },
          },
          overrides: [],
        },
      })
    ).toBe('compact-v1');
  });

  test.each([
    { lineColor: 'not-a-color' },
    { lineWidth: Number.NaN },
    { showPoints: 'sometimes' },
    { spanNulls: -2 },
    { axisPlacement: AxisPlacement.Bottom },
    { scaleDistribution: { type: ScaleDistribution.Log, log: 1 } },
    { insertNulls: true },
    { insertNulls: -1 },
    { insertNulls: Number.POSITIVE_INFINITY },
  ])('rejects malformed active compact configuration: %p', (custom) => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: { defaults: { custom }, overrides: [] },
      })
    ).toBeUndefined();
  });

  test.each([{ custom: 'invalid' }, { custom: [] }, { custom: { unknownFutureOption: undefined } }])(
    'rejects malformed or unknown custom configuration: %p',
    ({ custom }) => {
      expect(
        getPreferredDashboardQueryFormat({
          app: CoreApp.Dashboard,
          panelPluginId: 'timeseries',
          fieldConfig: { defaults: { custom: custom as never }, overrides: [] },
        })
      ).toBeUndefined();
    }
  );

  test.each([
    { reducer: ReducerID.last, op: 'unknown', value: 1 },
    { reducer: ReducerID.last, op: ComparisonOperation.GT, value: '1' },
  ])('rejects malformed value matcher options: %p', (options) => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: {
          defaults: {},
          overrides: [{ matcher: { id: FieldMatcherID.byValue, options }, properties: [] }],
        },
      })
    ).toBeUndefined();
  });

  test.each([
    { id: FieldMatcherID.byRegexp, options: '/[/' },
    { id: FieldMatcherID.byRegexpOrNames, options: { pattern: '/[/', names: [] } },
  ])('rejects malformed regular expression matcher options: %p', (matcher) => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        fieldConfig: { defaults: {}, overrides: [{ matcher, properties: [] }] },
      })
    ).toBeUndefined();
  });

  test('admits only one insertNulls threshold across a frame', () => {
    const context = { app: CoreApp.Dashboard, panelPluginId: 'timeseries' } as const;
    expect(
      getPreferredDashboardQueryFormat({
        ...context,
        fieldConfig: { defaults: { custom: { insertNulls: 60_000 } }, overrides: [] },
      })
    ).toBe('compact-v1');
    expect(
      getPreferredDashboardQueryFormat({
        ...context,
        fieldConfig: {
          defaults: { custom: { insertNulls: 60_000 } },
          overrides: [
            {
              matcher: { id: FieldMatcherID.byName, options: 'requests' },
              properties: [{ id: 'custom.insertNulls', value: 60_000 }],
            },
          ],
        },
      })
    ).toBe('compact-v1');
    expect(
      getPreferredDashboardQueryFormat({
        ...context,
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
    ).toBeUndefined();
    expect(
      getPreferredDashboardQueryFormat({
        ...context,
        fieldConfig: {
          defaults: {},
          overrides: [
            {
              matcher: { id: FieldMatcherID.byName, options: 'requests' },
              properties: [{ id: 'custom.insertNulls', value: 60_000 }],
            },
          ],
        },
      })
    ).toBeUndefined();
  });

  test('ignores disabled transformations', () => {
    expect(
      getPreferredDashboardQueryFormat({
        app: CoreApp.Dashboard,
        panelPluginId: 'timeseries',
        transformations: [{ id: 'reduce', disabled: true }],
      })
    ).toBe('compact-v1');
  });
});
