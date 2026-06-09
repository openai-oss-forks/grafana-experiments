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

  test('stays on JSON while the server query-service rewrite owns the endpoint', () => {
    const previous = config.featureToggles.queryServiceRewrite;
    config.featureToggles.queryServiceRewrite = true;
    try {
      expect(getPreferredDashboardQueryFormat({ app: CoreApp.Dashboard, panelPluginId: 'timeseries' })).toBeUndefined();
    } finally {
      config.featureToggles.queryServiceRewrite = previous;
    }
  });

  test('allows the transport to decide when the frontend query-service flag is enabled', () => {
    const previous = config.featureToggles.queryServiceFromUI;
    config.featureToggles.queryServiceFromUI = true;
    try {
      expect(getPreferredDashboardQueryFormat({ app: CoreApp.Dashboard, panelPluginId: 'timeseries' })).toBe(
        'compact-v1'
      );
    } finally {
      config.featureToggles.queryServiceFromUI = previous;
    }
  });

  test.each([
    { app: CoreApp.Explore, panelPluginId: 'timeseries' },
    { app: CoreApp.Dashboard, panelPluginId: 'table' },
    { app: CoreApp.Dashboard, panelPluginId: 'timeseries', isEditing: true },
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
      fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] },
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
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: {
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.byValue, options: { reducer: ReducerID.median } },
            properties: [],
          },
        ],
      },
    },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      legendCalcs: [ReducerID.median],
    },
    {
      app: CoreApp.Dashboard,
      panelPluginId: 'timeseries',
      fieldConfig: {
        defaults: {},
        overrides: [
          {
            matcher: { id: FieldMatcherID.byName, options: 'requests' },
            properties: [
              {
                id: FieldConfigProperty.Color,
                value: { mode: 'continuous-blues', seriesBy: ReducerID.median },
              },
            ],
          },
        ],
      },
    },
  ])('keeps unsupported request context on JSON: %p', (context) => {
    expect(getPreferredDashboardQueryFormat(context)).toBeUndefined();
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

  test('rejects unsupported default color reducers from runtime dashboard JSON', () => {
    const fieldConfig: FieldConfigSource = {
      defaults: { color: { mode: 'continuous-blues' } },
      overrides: [],
    };
    Reflect.set(fieldConfig.defaults.color!, 'seriesBy', ReducerID.median);

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

  test('supports palette-by-name and inert bar settings without admitting bars', () => {
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
        fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] },
      })
    ).toBeUndefined();
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
