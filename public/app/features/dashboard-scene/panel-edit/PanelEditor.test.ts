import { of } from 'rxjs';

import {
  COMPACT_TIME_SERIES_FORMAT,
  DataQueryRequest,
  DataSourceApi,
  FieldConfigSource,
  getDefaultTimeRange,
  LoadingState,
  PanelPlugin,
  standardTransformersRegistry,
} from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { config } from '@grafana/runtime';
import {
  CancelActivationHandler,
  CustomVariable,
  SceneDataTransformer,
  sceneGraph,
  SceneGridLayout,
  SceneQueryRunner,
  SceneTimeRange,
  SceneVariableSet,
  VizPanel,
} from '@grafana/scenes';
import { GraphDrawStyle, VizOrientation } from '@grafana/schema';
import { mockDataSource } from 'app/features/alerting/unified/mocks';
import { setupDataSources } from 'app/features/alerting/unified/testSetup/datasources';
import { DataSourceType } from 'app/features/alerting/unified/utils/datasource';
import * as libAPI from 'app/features/library-panels/state/api';
import { getStandardTransformers } from 'app/features/transformers/standardTransformers';

import { DashboardScene } from '../scene/DashboardScene';
import { DashboardSceneQueryRunner } from '../scene/DashboardSceneQueryRunner';
import { LibraryPanelBehavior } from '../scene/LibraryPanelBehavior';
import { DashboardGridItem } from '../scene/layout-default/DashboardGridItem';
import { DefaultGridLayoutManager } from '../scene/layout-default/DefaultGridLayoutManager';
import { vizPanelToPanel } from '../serialization/transformSceneToSaveModel';
import { activateFullSceneTree } from '../utils/test-utils';
import { findVizPanelByKey, getQueryRunnerFor } from '../utils/utils';

import { PanelDataPane } from './PanelDataPane/PanelDataPane';
import { PanelDataPaneNext } from './PanelEditNext/PanelDataPaneNext';
import { buildPanelEditScene, PanelEditor } from './PanelEditor';

const runRequestMock = jest.fn().mockImplementation((ds: DataSourceApi, request: DataQueryRequest) => {
  return of({
    state: LoadingState.Loading,
    series: [],
    timeRange: request.range,
  });
});

let pluginPromise: Promise<PanelPlugin> | undefined;

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getRunRequest: () => (ds: DataSourceApi, request: DataQueryRequest) => {
    return runRequestMock(ds, request);
  },
  getPluginImportUtils: () => ({
    getPanelPluginFromCache: jest.fn(() => undefined),
    importPanelPlugin: () => pluginPromise,
  }),
  config: {
    ...jest.requireActual('@grafana/runtime').config,
    panels: {
      text: {
        skipDataQuery: true,
      },
      timeseries: {
        skipDataQuery: false,
      },
    },
  },
}));

const dataSources = {
  ds1: mockDataSource(
    {
      uid: 'ds1',
      type: DataSourceType.Prometheus,
    },
    { module: 'core:plugin/prometheus' }
  ),
};

setupDataSources(...Object.values(dataSources));
standardTransformersRegistry.setInit(getStandardTransformers);

let deactivate: CancelActivationHandler | undefined;

describe('PanelEditor', () => {
  afterEach(() => {
    if (deactivate) {
      deactivate();
      deactivate = undefined;
    }
  });

  describe('When initializing', () => {
    it('should wait for panel plugin to load', async () => {
      const { panelEditor, panel, pluginResolve, dashboard } = await setup({ skipWait: true });

      expect(panel.state.options).toEqual({});
      expect(panelEditor.state.isInitializing).toBe(true);

      const pluginToLoad = getPanelPlugin({ id: 'text' }).setPanelOptions((build) => {
        build.addBooleanSwitch({
          path: 'showHeader',
          name: 'Show header',
          defaultValue: true,
        });
      });

      pluginResolve(pluginToLoad);

      await new Promise((r) => setTimeout(r, 1));

      expect(panelEditor.state.isInitializing).toBe(false);
      expect(panel.state.options).toEqual({ showHeader: true });

      panel.onOptionsChange({ showHeader: false });
      panelEditor.onDiscard();

      const discardedPanel = findVizPanelByKey(dashboard, panel.state.key!)!;
      expect(discardedPanel.state.options).toEqual({ showHeader: true });
    });
  });

  describe('Entering panel edit', () => {
    it.each([
      [
        'compact',
        {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          compactSeries: createCompactSeries(),
        },
      ],
      [
        'streaming',
        {
          state: LoadingState.Streaming,
          series: [],
          timeRange: getDefaultTimeRange(),
        },
      ],
    ])('restarts inactive %s data through the panel editor wrapper', (_name, data) => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
      const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
      queryRunner.setState({ data });
      const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
      const panel = new VizPanel({ key: 'panel-1', pluginId: 'timeseries', $data: queryRunner });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });

      deactivate = activateFullSceneTree(dashboard);

      expect(runQueries).toHaveBeenCalledTimes(1);
      expect(panel.state.$data).toBeInstanceOf(SceneDataTransformer);

      deactivate();
      deactivate = undefined;

      expect(panel.state.$data).toBe(queryRunner);
    });

    it('reruns a compact query when field configuration requires the full response format', async () => {
      const { panel, dashboard, queryRunner, cancelQuery, runQueries } = await setupCompactTimeSeriesEditor();

      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] }, true);

      expect(dashboard.enrichDataRequest(queryRunner).preferredQueryResultFormat).toBeUndefined();
      expect(cancelQuery).toHaveBeenCalledTimes(1);
      expect(runQueries).toHaveBeenCalledTimes(1);

      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] }, true);

      expect(cancelQuery).toHaveBeenCalledTimes(1);
      expect(runQueries).toHaveBeenCalledTimes(1);
    });

    it('starts one full-format query when incompatible compact data is present on activation', async () => {
      const { dashboard, queryRunner, cancelQuery, runQueries } = await setupCompactTimeSeriesEditor({
        clearSpies: false,
        fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] },
      });

      expect(dashboard.enrichDataRequest(queryRunner).preferredQueryResultFormat).toBeUndefined();
      expect(cancelQuery).not.toHaveBeenCalled();
      expect(runQueries).toHaveBeenCalledTimes(1);
      expect(queryRunner.state.data?.compactSeries).toBeUndefined();
    });

    it('lets an unprepared request adopt incompatible configuration', async () => {
      const { panel, cancelQuery, runQueries } = await setupCompactTimeSeriesEditor({ withCompactData: false });

      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] }, true);

      expect(cancelQuery).not.toHaveBeenCalled();
      expect(runQueries).not.toHaveBeenCalled();
    });

    it('reruns a compact query in full format when table view opens', async () => {
      const { panelEditor, dashboard, queryRunner, cancelQuery, runQueries } = await setupCompactTimeSeriesEditor();

      panelEditor.onToggleTableView();

      expect(panelEditor.state.tableView).toBeDefined();
      expect(dashboard.enrichDataRequest(queryRunner).preferredQueryResultFormat).toBeUndefined();
      expect(cancelQuery).toHaveBeenCalledTimes(1);
      expect(runQueries).toHaveBeenCalledTimes(1);
      expect(queryRunner.state.data?.compactSeries).toBeUndefined();
    });

    it('reruns a compact query in full format when a transformation is enabled', async () => {
      const { panel, dashboard, queryRunner, cancelQuery, runQueries } = await setupCompactTimeSeriesEditor();
      const transformer = panel.state.$data;
      expect(transformer).toBeInstanceOf(SceneDataTransformer);

      (transformer as SceneDataTransformer).setState({
        transformations: [{ id: 'organize', options: {} }],
      });

      expect(dashboard.enrichDataRequest(queryRunner).preferredQueryResultFormat).toBeUndefined();
      expect(cancelQuery).toHaveBeenCalledTimes(1);
      expect(runQueries).toHaveBeenCalledTimes(1);
    });

    it('does not restart a full-format request that retains stale compact data while loading', async () => {
      const { panel, queryRunner, cancelQuery, runQueries } = await setupCompactTimeSeriesEditor();
      queryRunner.setState({
        data: {
          ...queryRunner.state.data!,
          state: LoadingState.Loading,
          request: { preferredQueryResultFormat: undefined } as DataQueryRequest,
        },
      });

      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] }, true);

      expect(cancelQuery).not.toHaveBeenCalled();
      expect(runQueries).not.toHaveBeenCalled();
    });

    it('restarts a compact refresh that still exposes the previous full-format response', async () => {
      const { panel, queryRunner, cancelQuery, runQueries } = await setupCompactTimeSeriesEditor();
      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] }, true);
      queryRunner.setState({
        data: {
          ...queryRunner.state.data!,
          compactSeries: undefined,
          request: { preferredQueryResultFormat: undefined } as DataQueryRequest,
        },
      });
      cancelQuery.mockClear();
      runQueries.mockClear();

      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Line } }, overrides: [] }, true);
      prepareDashboardQuery(queryRunner);
      expect(queryRunner.getLastPreparedRequest()?.preferredQueryResultFormat).toBe('compact-v1');
      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] }, true);

      expect(cancelQuery).toHaveBeenCalledTimes(1);
      expect(runQueries).toHaveBeenCalledTimes(1);
    });

    it('wraps eligible compact dashboard data before the first response arrives', () => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
      const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
      jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
      const panel = new VizPanel({ key: 'panel-1', pluginId: 'timeseries', $data: queryRunner });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });

      deactivate = activateFullSceneTree(dashboard);

      expect(panel.state.$data).toBeInstanceOf(SceneDataTransformer);
    });

    it('wraps non-compact dashboard data while editing and restores it on exit', () => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
      const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
      jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
      const panel = new VizPanel({
        key: 'panel-1',
        pluginId: 'timeseries',
        options: { orientation: VizOrientation.Vertical },
        $data: queryRunner,
      });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });

      deactivate = activateFullSceneTree(dashboard);

      expect(panel.state.$data).toBeInstanceOf(SceneDataTransformer);

      deactivate();
      deactivate = undefined;

      expect(panel.state.$data).toBe(queryRunner);
    });

    it('keeps transformations added to the compact edit wrapper', () => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
      const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
      queryRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          compactSeries: createCompactSeries(),
        },
      });
      jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
      const panel = new VizPanel({ key: 'panel-1', pluginId: 'timeseries', $data: queryRunner });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });

      deactivate = activateFullSceneTree(dashboard);
      const transformer = panel.state.$data;
      expect(transformer).toBeInstanceOf(SceneDataTransformer);
      (transformer as SceneDataTransformer).setState({
        transformations: [{ id: 'organize', options: {} }],
      });

      deactivate();
      deactivate = undefined;

      expect(panel.state.$data).toBe(transformer);
    });

    it('does not unwrap an existing data transformer when leaving panel edit', () => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
      const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
      jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
      const transformer = new SceneDataTransformer({ $data: queryRunner, transformations: [] });
      const panel = new VizPanel({ key: 'panel-1', pluginId: 'timeseries', $data: transformer });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });

      deactivate = activateFullSceneTree(dashboard);
      deactivate();
      deactivate = undefined;

      expect(panel.state.$data).toBe(transformer);
    });

    it('should clear edit pane selection', () => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'text', skipDataQuery: true }));

      const panel = new VizPanel({
        key: 'panel-1',
        pluginId: 'text',
        title: 'original title',
      });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
        body: new DefaultGridLayoutManager({
          grid: new SceneGridLayout({
            children: [gridItem],
          }),
        }),
      });

      dashboard.state.editPane.selectObject(panel, panel.state.key!, { force: true });
      expect(dashboard.state.editPane.getSelection()).toBe(panel);

      deactivate = activateFullSceneTree(dashboard);

      expect(dashboard.state.editPane.getSelection()).toBeUndefined();
    });
  });

  describe('When discarding', () => {
    it('should discard changes revert all changes', async () => {
      const { panelEditor, panel, dashboard } = await setup();

      panel.setState({ title: 'changed title' });
      panelEditor.onDiscard();

      const discardedPanel = findVizPanelByKey(dashboard, panel.state.key!)!;

      expect(discardedPanel.state.title).toBe('original title');
    });

    it('does not commit the detached changed panel after discard', async () => {
      const { panelEditor, panel, dashboard } = await setup();
      const setPanelEditAction = jest.spyOn(dashboard.state.editPane, 'setPanelEditAction');
      const previousNewLayoutsToggle = config.featureToggles.dashboardNewLayouts;
      config.featureToggles.dashboardNewLayouts = true;

      try {
        panel.setState({ title: 'discarded title' });
        panelEditor.onDiscard();
        deactivate?.();
        deactivate = undefined;

        expect(setPanelEditAction).not.toHaveBeenCalled();
      } finally {
        config.featureToggles.dashboardNewLayouts = previousNewLayoutsToggle;
      }
    });

    it('should discard a newly added panel', async () => {
      const { panelEditor, dashboard } = await setup({ isNewPanel: true });
      panelEditor.onDiscard();

      const panels = dashboard.state.body.getVizPanels();
      expect(panels.length).toBe(0);
    });

    it('should discard query runner changes', async () => {
      const { panelEditor, panel, dashboard } = await setup({});

      const queryRunner = getQueryRunnerFor(panel);
      queryRunner?.setState({ maxDataPoints: 123, queries: [{ refId: 'A' }, { refId: 'B' }] });

      panelEditor.onDiscard();

      const discardedPanel = findVizPanelByKey(dashboard, panel.state.key!)!;
      const restoredQueryRunner = getQueryRunnerFor(discardedPanel);
      expect(restoredQueryRunner?.state.maxDataPoints).toBe(500);
      expect(restoredQueryRunner?.state.queries.length).toBe(1);
    });
  });

  describe('When changes are made', () => {
    it('Should set state to dirty', async () => {
      const { panelEditor, panel } = await setup({});

      expect(panelEditor.state.isDirty).toBe(undefined);

      panel.setState({ title: 'changed title' });

      expect(panelEditor.state.isDirty).toBe(true);
    });

    it('Should reset dirty and orginal state when dashboard is saved', async () => {
      const { panelEditor, panel } = await setup({});

      expect(panelEditor.state.isDirty).toBe(undefined);

      panel.setState({ title: 'changed title' });

      panelEditor.dashboardSaved();

      expect(panelEditor.state.isDirty).toBe(false);

      panel.setState({ title: 'changed title 2' });

      expect(panelEditor.state.isDirty).toBe(true);

      // Change back to already saved state
      panel.setState({ title: 'changed title' });
      expect(panelEditor.state.isDirty).toBe(false);
    });

    it('commits an immediately completed plugin change before dirty detection is debounced', async () => {
      const { panelEditor, dashboard } = await setup({ debounceSaveModelDiff: true });
      const setPanelEditAction = jest.spyOn(dashboard.state.editPane, 'setPanelEditAction');
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'barchart' }));
      const previousNewLayoutsToggle = config.featureToggles.dashboardNewLayouts;
      config.featureToggles.dashboardNewLayouts = true;
      jest.useFakeTimers();

      try {
        await panelEditor.state.optionsPane!.onChangePanel({ pluginId: 'barchart' });

        expect(panelEditor.getPanel().state.pluginId).toBe('barchart');
        expect(panelEditor.state.isDirty).toBeUndefined();
        deactivate?.();
        deactivate = undefined;

        expect(setPanelEditAction).toHaveBeenCalledTimes(1);
      } finally {
        config.featureToggles.dashboardNewLayouts = previousNewLayoutsToggle;
        jest.useRealTimers();
      }
    });
  });

  describe('When opening a repeated panel', () => {
    it('Should default to the first variable value if panel is repeated', async () => {
      const { panel } = await setup({ repeatByVariable: 'server' });
      const variable = sceneGraph.lookupVariable('server', panel);
      expect(variable?.getValue()).toBe('A');
    });
  });

  describe('Visualization preview', () => {
    it('starts with the visualization and configuration of the panel being edited', () => {
      const options = { orientation: VizOrientation.Horizontal };
      const fieldConfig = {
        defaults: { custom: { drawStyle: GraphDrawStyle.Bars } },
        overrides: [],
      };
      const panel = new VizPanel({
        pluginId: 'barchart',
        pluginVersion: '1.2.3',
        title: 'Bar panel',
        description: 'Panel description',
        options,
        fieldConfig,
        seriesLimit: 321,
      });

      const preview = PanelEditor.buildEditPreview(panel);

      expect(preview.state).toMatchObject({
        pluginId: 'barchart',
        pluginVersion: '1.2.3',
        title: 'Bar panel',
        description: 'Panel description',
        options,
        fieldConfig,
        seriesLimit: 321,
      });
      expect(preview.state.options).not.toBe(panel.state.options);
      expect(preview.state.fieldConfig).not.toBe(panel.state.fieldConfig);
    });

    it('cancels a plugin preload when panel edit closes', async () => {
      const { panelEditor, panel } = await setup();
      let resolvePlugin!: (plugin: PanelPlugin) => void;
      pluginPromise = new Promise<PanelPlugin>((resolve) => {
        resolvePlugin = resolve;
      });

      const change = panelEditor.state.optionsPane!.onChangePanel({ pluginId: 'barchart' });

      deactivate?.();
      deactivate = undefined;
      resolvePlugin(getPanelPlugin({ id: 'barchart' }));
      await change;

      expect(panel.state.pluginId).toBe('text');
    });

    it('commits a plugin change that already started when panel edit closes', async () => {
      const { panelEditor, panel, dashboard, gridItem } = await setup({ pluginSkipDataQuery: false });
      const previousNewLayoutsToggle = config.featureToggles.dashboardNewLayouts;
      config.featureToggles.dashboardNewLayouts = true;
      let finishPluginChange!: () => void;
      let pluginChangeFinished = false;
      const targetPlugin = getPanelPlugin({ id: 'barchart', skipDataQuery: true });
      panel.getPlugin = jest.fn(() => (pluginChangeFinished ? targetPlugin : undefined));
      panel.changePluginType = jest.fn(
        (pluginId: string) =>
          new Promise<void>((resolve) => {
            finishPluginChange = () => {
              pluginChangeFinished = true;
              panel.setState({ pluginId });
              resolve();
            };
          })
      );

      try {
        const change = panelEditor.state.optionsPane!.onChangePanel({ pluginId: 'barchart' });
        await new Promise(process.nextTick);
        Reflect.get(panelEditor, '_internalDeactivate').call(panelEditor);
        dashboard.setState({ editPanel: undefined });

        expect(dashboard.state.editPane.state.undoStack).toHaveLength(0);
        let saveGateFinished = false;
        const saveGate = dashboard.waitForPendingPanelEditCompletion().then(() => {
          saveGateFinished = true;
        });
        await Promise.resolve();
        expect(saveGateFinished).toBe(false);

        finishPluginChange();
        await Promise.all([change, saveGate]);
        await new Promise(process.nextTick);
        expect(saveGateFinished).toBe(true);
        expect(dashboard.state.editPane.state.undoStack).toHaveLength(1);
        expect((gridItem.state.body as VizPanel).state.pluginId).toBe('barchart');
        expect((gridItem.state.body as VizPanel).state.$data).toBeUndefined();

        dashboard.state.editPane.undoAction();
        expect((gridItem.state.body as VizPanel).state.pluginId).toBe('text');
        dashboard.state.editPane.redoAction();
        expect((gridItem.state.body as VizPanel).state.pluginId).toBe('barchart');
      } finally {
        config.featureToggles.dashboardNewLayouts = previousNewLayoutsToggle;
      }
    });
  });

  describe('Changing between data and non-data visualizations', () => {
    it.each([LoadingState.Loading, LoadingState.Streaming])(
      'preserves queries and transformations and restarts a %s query across the round trip',
      async (loadingState) => {
        const queryRunner = new SceneQueryRunner({
          datasource: { uid: 'ds1' },
          queries: [
            { refId: 'A', expr: 'up' },
            { refId: 'B', expr: 'rate(requests_total[5m])' },
          ],
        });
        const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
        const transformer = new SceneDataTransformer({
          $data: queryRunner,
          transformations: [{ id: 'organize', options: { excludeByName: { Time: true } }, disabled: true }],
        });
        const panel = new VizPanel({ key: 'panel-1', pluginId: 'timeseries', $data: transformer });
        const gridItem = new DashboardGridItem({ body: panel });
        const panelEditor = buildPanelEditScene(panel);
        const dashboard = new DashboardScene({
          editPanel: panelEditor,
          isEditing: true,
          $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
          body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
        });
        pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
        deactivate = activateFullSceneTree(dashboard);
        await new Promise((resolve) => setTimeout(resolve, 1));
        queryRunner.setState({
          data: {
            state: loadingState,
            series: [],
            timeRange: getDefaultTimeRange(),
          },
        });
        runQueries.mockClear();

        pluginPromise = Promise.resolve(getPanelPlugin({ id: 'text', skipDataQuery: true }));
        await panel.changePluginType('text');
        expect(panel.state.$data).toBeUndefined();
        pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
        await panel.changePluginType('timeseries');

        expect(panel.state.$data).toBe(transformer);
        expect(transformer.state.$data).toBe(queryRunner);
        expect(queryRunner.state.datasource).toEqual({ uid: 'ds1' });
        expect(queryRunner.state.queries).toEqual([
          { refId: 'A', expr: 'up' },
          { refId: 'B', expr: 'rate(requests_total[5m])' },
        ]);
        expect(transformer.state.transformations).toEqual([
          { id: 'organize', options: { excludeByName: { Time: true } }, disabled: true },
        ]);
        expect(runQueries).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe('Handling library panels', () => {
    it('should call the api with the updated panel', async () => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'text', skipDataQuery: true }));

      const panel = new VizPanel({ key: 'panel-1', pluginId: 'text' });
      const libraryPanelModel = {
        title: 'title',
        uid: 'uid',
        name: 'libraryPanelName',
        model: vizPanelToPanel(panel),
        type: 'panel',
        version: 1,
      };

      const libPanelBehavior = new LibraryPanelBehavior({
        isLoaded: true,
        uid: libraryPanelModel.uid,
        name: libraryPanelModel.name,
        _loadedPanel: libraryPanelModel,
      });

      panel.setState({ $behaviors: [libPanelBehavior] });

      const gridItem = new DashboardGridItem({ body: panel });
      const editScene = buildPanelEditScene(panel);
      const scene = new DashboardScene({
        editPanel: editScene,
        $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
        isEditing: true,
        body: new DefaultGridLayoutManager({
          grid: new SceneGridLayout({
            children: [gridItem],
          }),
        }),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      panel.setState({ title: 'changed title' });
      libPanelBehavior.setState({ name: 'changed name' });

      jest.spyOn(libAPI, 'saveLibPanel').mockImplementation(async (panel) => {
        const updatedPanel = { ...libAPI.libraryVizPanelToSaveModel(panel), version: 2 };
        libPanelBehavior.setPanelFromLibPanel(updatedPanel);
      });

      await editScene.onConfirmSaveLibraryPanel();

      // Wait for mock api to return and update the library panel
      expect(libPanelBehavior.state._loadedPanel?.version).toBe(2);
      expect(libPanelBehavior.state.name).toBe('changed name');
      expect(panel.state.title).toBe('changed title');
      expect((gridItem.state.body as VizPanel).state.title).toBe('changed title');
    });

    it('coalesces concurrent library panel saves', async () => {
      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'text', skipDataQuery: true }));
      const panel = new VizPanel({ key: 'panel-1', pluginId: 'text' });
      new DashboardGridItem({ body: panel });
      const editScene = buildPanelEditScene(panel);
      let finishSave!: () => void;
      const saveLibPanel = jest.spyOn(libAPI, 'saveLibPanel').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          })
      );
      saveLibPanel.mockClear();

      const firstSave = editScene.onConfirmSaveLibraryPanel();
      const secondSave = editScene.onConfirmSaveLibraryPanel();

      expect(secondSave).toBe(firstSave);
      expect(saveLibPanel).toHaveBeenCalledTimes(1);
      finishSave();
      await expect(firstSave).resolves.toBe(true);
      await expect(secondSave).resolves.toBe(true);
    });

    it('unlinks library panel', () => {
      const libraryPanelModel = {
        title: 'title',
        uid: 'uid',
        name: 'libraryPanelName',
        model: {
          title: 'title',
          type: 'text',
        },
        type: 'panel',
        version: 1,
      };

      const libPanelBehavior = new LibraryPanelBehavior({
        isLoaded: true,
        uid: libraryPanelModel.uid,
        name: libraryPanelModel.name,
        _loadedPanel: libraryPanelModel,
      });

      // Just adding an extra stateless behavior to verify unlinking does not remvoe it
      const otherBehavior = jest.fn();
      const panel = new VizPanel({ key: 'panel-1', pluginId: 'text', $behaviors: [libPanelBehavior, otherBehavior] });
      new DashboardGridItem({ body: panel });

      const editScene = buildPanelEditScene(panel);
      editScene.onConfirmUnlinkLibraryPanel();

      expect(panel.state.$behaviors?.length).toBe(1);
      expect(panel.state.$behaviors![0]).toBe(otherBehavior);
    });
  });

  describe('PanelDataPane', () => {
    it('should not exist if panel is skipDataQuery', async () => {
      const { panelEditor, panel } = await setup({ pluginSkipDataQuery: true });
      expect(panelEditor.state.dataPane).toBeUndefined();

      expect(panel.state.$data).toBeUndefined();
    });

    it('should exist if panel is supporting querying', async () => {
      const { panelEditor, panel } = await setup({ pluginSkipDataQuery: false });
      expect(panelEditor.state.dataPane).toBeDefined();

      expect(panel.state.$data).toBeDefined();
    });
  });

  describe('Query editor version toggle', () => {
    describe('when queryEditorNext feature toggle is enabled', () => {
      beforeEach(() => {
        config.featureToggles.queryEditorNext = true;
      });

      afterEach(() => {
        config.featureToggles.queryEditorNext = false;
      });

      it('should use the v2 query editor experience by default', async () => {
        const { panelEditor } = await setup({ pluginSkipDataQuery: false });

        expect(panelEditor.state.dataPane).toBeInstanceOf(PanelDataPaneNext);
      });

      it('should switch to v1 query editor experience when toggled off', async () => {
        const { panelEditor } = await setup({ pluginSkipDataQuery: false });

        panelEditor.onToggleQueryEditorVersion();

        expect(panelEditor.state.dataPane).toBeInstanceOf(PanelDataPane);
      });

      it('should switch back to v2 query editor experience when toggled on again', async () => {
        const { panelEditor } = await setup({ pluginSkipDataQuery: false });

        panelEditor.onToggleQueryEditorVersion(); // v2 -> v1
        panelEditor.onToggleQueryEditorVersion(); // v1 -> v2

        expect(panelEditor.state.dataPane).toBeInstanceOf(PanelDataPaneNext);
      });
    });

    describe('when queryEditorNext feature toggle is disabled', () => {
      beforeEach(() => {
        config.featureToggles.queryEditorNext = false;
      });

      it('should use the v1 query editor experience', async () => {
        const { panelEditor } = await setup({ pluginSkipDataQuery: false });

        expect(panelEditor.state.dataPane).toBeInstanceOf(PanelDataPane);
      });
    });
  });
});

function createCompactSeries() {
  return {
    kind: 'compact-response-view' as const,
    format: COMPACT_TIME_SERIES_FORMAT,
    buffer: new ArrayBuffer(0),
    metadata: {
      getLabel: () => undefined,
      forEachLabel: () => undefined,
      materializeLabels: () => undefined,
    },
    decodeStats: {
      responseBytes: 0,
      axisCount: 0,
      resultCount: 0,
      stringCount: 0,
      stringBytes: 0,
      seriesCount: 0,
    },
    axes: [],
    series: [],
  };
}

function createTimeSeriesTestPlugin() {
  return getPanelPlugin({ id: 'timeseries', skipDataQuery: false }).useFieldConfig({
    useCustomConfig: (builder) => {
      builder.addTextInput({
        name: 'Draw style',
        path: 'drawStyle',
        defaultValue: GraphDrawStyle.Line,
      });
    },
  });
}

async function setupCompactTimeSeriesEditor({
  clearSpies = true,
  fieldConfig,
  withCompactData = true,
}: {
  clearSpies?: boolean;
  fieldConfig?: FieldConfigSource;
  withCompactData?: boolean;
} = {}) {
  pluginPromise = Promise.resolve(createTimeSeriesTestPlugin());
  const queryRunner = new DashboardSceneQueryRunner({ queries: [{ refId: 'A' }] });
  if (withCompactData) {
    queryRunner.setState({
      data: {
        state: LoadingState.Done,
        series: [],
        timeRange: getDefaultTimeRange(),
        compactSeries: createCompactSeries(),
      },
    });
  }
  const cancelQuery = jest.spyOn(queryRunner, 'cancelQuery').mockImplementation(() => {});
  const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
  const panel = new VizPanel({ key: 'panel-1', pluginId: 'timeseries', fieldConfig, $data: queryRunner });
  const gridItem = new DashboardGridItem({ body: panel });
  const panelEditor = buildPanelEditScene(panel);
  const dashboard = new DashboardScene({
    editPanel: panelEditor,
    isEditing: true,
    $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
    body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
  });

  deactivate = activateFullSceneTree(dashboard);
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (withCompactData && dashboard.enrichDataRequest(queryRunner).preferredQueryResultFormat === 'compact-v1') {
    queryRunner.setState({
      data: {
        state: LoadingState.Done,
        series: [],
        timeRange: getDefaultTimeRange(),
        compactSeries: createCompactSeries(),
      },
    });
  }
  if (clearSpies) {
    cancelQuery.mockClear();
    runQueries.mockClear();
  }

  return { panel, panelEditor, dashboard, queryRunner, cancelQuery, runQueries };
}

function prepareDashboardQuery(queryRunner: DashboardSceneQueryRunner) {
  const prepareRequests = Reflect.get(queryRunner, 'prepareRequests') as (
    timeRange: ReturnType<typeof sceneGraph.getTimeRange>,
    dataSource: DataSourceApi
  ) => unknown;
  const dataSource = {
    interval: '',
    meta: {},
    getRef: () => ({ uid: 'ds1', type: DataSourceType.Prometheus }),
  } as DataSourceApi;
  prepareRequests.call(queryRunner, sceneGraph.getTimeRange(queryRunner), dataSource);
}

interface SetupOptions {
  isNewPanel?: boolean;
  pluginSkipDataQuery?: boolean;
  repeatByVariable?: string;
  skipWait?: boolean;
  pluginLoadTime?: number;
  debounceSaveModelDiff?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const pluginToLoad = getPanelPlugin({ id: 'text', skipDataQuery: options.pluginSkipDataQuery });
  let pluginResolve = (plugin: PanelPlugin) => {};

  pluginPromise = new Promise<PanelPlugin>((resolve) => {
    pluginResolve = resolve;
  });

  const panel = new VizPanel({
    key: 'panel-1',
    pluginId: 'text',
    title: 'original title',
    $data: new SceneDataTransformer({
      transformations: [],
      $data: new SceneQueryRunner({
        queries: [{ refId: 'A' }],
        maxDataPoints: 500,
        datasource: { uid: 'ds1' },
      }),
    }),
  });

  const gridItem = new DashboardGridItem({ body: panel, variableName: options.repeatByVariable });

  const panelEditor = buildPanelEditScene(panel, options.isNewPanel);
  const dashboard = new DashboardScene({
    editPanel: panelEditor,
    isEditing: true,
    $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
    $variables: new SceneVariableSet({
      variables: [
        new CustomVariable({
          name: 'server',
          query: 'A,B,C',
          isMulti: true,
          value: ['A', 'B', 'C'],
          text: ['A', 'B', 'C'],
        }),
      ],
    }),
    body: new DefaultGridLayoutManager({
      grid: new SceneGridLayout({
        children: [gridItem],
      }),
    }),
  });

  panelEditor.debounceSaveModelDiff = options.debounceSaveModelDiff ?? false;

  deactivate = activateFullSceneTree(dashboard);

  if (!options.skipWait) {
    //console.log('pluginResolve(pluginToLoad)');
    pluginResolve(pluginToLoad);
    await new Promise((r) => setTimeout(r, 1));
  }

  return { dashboard, panel, gridItem, panelEditor, pluginResolve };
}
