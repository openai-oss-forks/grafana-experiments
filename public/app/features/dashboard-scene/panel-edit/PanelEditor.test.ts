import { waitFor } from '@testing-library/react';
import { of } from 'rxjs';

import {
  COMPACT_TIME_SERIES_FORMAT,
  DataQueryRequest,
  DataSourceApi,
  getDefaultTimeRange,
  LoadingState,
  PanelPlugin,
  standardTransformersRegistry,
  toDataFrame,
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
import { buildPanelEditScene } from './PanelEditor';

const defaultRunRequest = (_ds: DataSourceApi, request: DataQueryRequest) => {
  return of({
    state: LoadingState.Loading,
    series: [],
    timeRange: request.range,
  });
};
const runRequestMock = jest.fn(defaultRunRequest);

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
    runRequestMock.mockReset().mockImplementation(defaultRunRequest);
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
      { isNewPanel: true, isHidden: false, expectedPluginId: 'logs' },
      { isNewPanel: true, isHidden: true, expectedPluginId: 'timeseries' },
      { isNewPanel: false, isHidden: false, expectedPluginId: 'timeseries' },
    ])(
      'applies visualization preferences only to visible queries in new panels (new: $isNewPanel, hidden: $isHidden)',
      async ({ isNewPanel, isHidden, expectedPluginId }) => {
        pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
        const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A', hide: isHidden }] });
        jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
        const panel = new VizPanel({ key: 'panel-1', pluginId: 'timeseries', $data: queryRunner });
        const gridItem = new DashboardGridItem({ body: panel });
        const panelEditor = buildPanelEditScene(panel, isNewPanel);
        const dashboard = new DashboardScene({
          editPanel: panelEditor,
          isEditing: true,
          $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
          body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
        });

        deactivate = activateFullSceneTree(dashboard);
        pluginPromise = Promise.resolve(getPanelPlugin({ id: 'logs', skipDataQuery: false }));

        queryRunner.setState({
          data: {
            state: LoadingState.Done,
            series: [
              toDataFrame({
                refId: 'A',
                meta: { preferredVisualisationType: 'logs' },
                fields: [],
              }),
            ],
            timeRange: getDefaultTimeRange(),
          },
        });

        await waitFor(() => expect(panel.state.pluginId).toBe(expectedPluginId));
      }
    );

    it('does not replace an explicitly selected Time series visualization for a new panel', async () => {
      const { panel, panelEditor } = await setup({ isNewPanel: true });
      const optionsPane = panelEditor.state.optionsPane!;
      const queryRunner = getQueryRunnerFor(panel)!;

      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'timeseries', skipDataQuery: false }));
      optionsPane.onChangePanel({ pluginId: 'timeseries', withModKey: true });

      expect(optionsPane.state.hasPickedViz).toBe(true);
      await waitFor(() => expect(panel.state.pluginId).toBe('timeseries'));

      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'logs', skipDataQuery: false }));
      queryRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [
            toDataFrame({
              refId: 'A',
              meta: { preferredVisualisationType: 'logs' },
              fields: [],
            }),
          ],
          timeRange: getDefaultTimeRange(),
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(panel.state.pluginId).toBe('timeseries');
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

    it('matches prepared and network request formats to the final panel configuration', async () => {
      pluginPromise = Promise.resolve(createTimeSeriesTestPlugin());
      runRequestMock.mockImplementation((_ds, request) =>
        of({
          state: LoadingState.Done,
          series: [],
          timeRange: request.range,
          request,
          compactSeries: request.preferredQueryResultFormat === 'compact-v1' ? createCompactSeries() : undefined,
        })
      );
      const queryRunner = new DashboardSceneQueryRunner({
        datasource: { uid: 'ds1' },
        queries: [{ refId: 'A', expr: 'up' }],
        runQueriesMode: 'manual',
      });
      queryRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: 'existing-full' } as DataQueryRequest,
        },
      });
      const panel = new VizPanel({
        key: 'panel-1',
        pluginId: 'timeseries',
        fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Line } }, overrides: [] },
        $data: queryRunner,
      });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });
      deactivate = activateFullSceneTree(dashboard);

      const expectLatestFormat = (format: 'compact-v1' | undefined) => {
        const preparedRequest = queryRunner.getLastPreparedRequest();
        const networkRequest = runRequestMock.mock.lastCall?.[1];
        expect(preparedRequest?.preferredQueryResultFormat).toBe(format);
        expect(networkRequest?.preferredQueryResultFormat).toBe(format);
        expect(preparedRequest?.requestId).toBe(networkRequest?.requestId);
        expect(queryRunner.state.data?.request?.preferredQueryResultFormat).toBe(format);
      };
      await waitFor(() => expectLatestFormat('compact-v1'));

      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Bars } }, overrides: [] }, true);
      await waitFor(() => expectLatestFormat('compact-v1'));

      panel.onFieldConfigChange({ defaults: { custom: { drawStyle: GraphDrawStyle.Line } }, overrides: [] }, true);
      await waitFor(() => expectLatestFormat('compact-v1'));

      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'barchart', skipDataQuery: false }));
      await panel.changePluginType('barchart');
      await waitFor(() => expectLatestFormat('compact-v1'));

      panel.onOptionsChange({ xField: 'category' });
      await waitFor(() => expectLatestFormat(undefined));
      expect(queryRunner.state.data?.compactSeries).toBeUndefined();

      panel.onOptionsChange({ xField: undefined });
      await waitFor(() => expectLatestFormat('compact-v1'));

      pluginPromise = Promise.resolve(createTimeSeriesTestPlugin());
      await panel.changePluginType('timeseries');
      expect(dashboard.enrichDataRequest(queryRunner).preferredQueryResultFormat).toBe('compact-v1');
      await waitFor(() => expectLatestFormat('compact-v1'));

      const transformer = panel.state.$data;
      expect(transformer).toBeInstanceOf(SceneDataTransformer);
      const dataTransformer = transformer as SceneDataTransformer;
      dataTransformer.setState({ transformations: [{ id: 'organize', options: {} }] });
      queryRunner.runQueries();
      await waitFor(() => expectLatestFormat(undefined));

      dataTransformer.setState({ transformations: [] });
      await waitFor(() => expectLatestFormat('compact-v1'));
    });

    it('does not request an unattainable compact replacement for a mixed datasource', () => {
      pluginPromise = Promise.resolve(createTimeSeriesTestPlugin());
      const queryRunner = new DashboardSceneQueryRunner({
        datasource: { uid: '-- Mixed --', type: 'mixed' },
        queries: [{ refId: 'A', expr: 'up' }],
        runQueriesMode: 'manual',
      });
      queryRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: 'existing-full' } as DataQueryRequest,
        },
      });
      const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
      const panel = new VizPanel({
        key: 'panel-1',
        pluginId: 'timeseries',
        fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Line } }, overrides: [] },
        $data: queryRunner,
      });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });

      deactivate = activateFullSceneTree(dashboard);

      expect(runQueries).not.toHaveBeenCalled();
    });

    it('keeps replacement data loading across compact format changes', async () => {
      pluginPromise = Promise.resolve(createTimeSeriesTestPlugin());
      const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
      queryRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          compactSeries: createCompactSeries(),
        },
      });
      const runQueries = jest.spyOn(queryRunner, 'runQueries').mockImplementation(() => {});
      const panel = new VizPanel({
        key: 'panel-1',
        pluginId: 'timeseries',
        fieldConfig: { defaults: { custom: { drawStyle: GraphDrawStyle.Line } }, overrides: [] },
        $data: queryRunner,
      });
      const gridItem = new DashboardGridItem({ body: panel });
      const panelEditor = buildPanelEditScene(panel);
      const dashboard = new DashboardScene({
        editPanel: panelEditor,
        isEditing: true,
        $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
        body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [gridItem] }) }),
      });
      deactivate = activateFullSceneTree(dashboard);

      pluginPromise = Promise.resolve(getPanelPlugin({ id: 'barchart', skipDataQuery: false }));
      await panel.changePluginType('barchart');
      runQueries.mockClear();
      panel.onOptionsChange({ xField: 'category' });

      expect(queryRunner.state.data).toMatchObject({
        state: LoadingState.Loading,
        compactSeries: undefined,
      });
      expect(runQueries).toHaveBeenCalledTimes(1);

      queryRunner.setState({
        data: {
          ...queryRunner.state.data!,
          state: LoadingState.Loading,
          request: { requestId: 'in-flight-full' } as DataQueryRequest,
        },
      });
      runQueries.mockClear();
      panel.onOptionsChange({ xField: undefined });

      expect(queryRunner.state.data?.state).toBe(LoadingState.Loading);
      expect(runQueries).toHaveBeenCalledTimes(1);
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
  });

  describe('When opening a repeated panel', () => {
    it('Should default to the first variable value if panel is repeated', async () => {
      const { panel } = await setup({ repeatByVariable: 'server' });
      const variable = sceneGraph.lookupVariable('server', panel);
      expect(variable?.getValue()).toBe('A');
    });
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

      editScene.onConfirmSaveLibraryPanel();
      await new Promise(process.nextTick);

      // Wait for mock api to return and update the library panel
      expect(libPanelBehavior.state._loadedPanel?.version).toBe(2);
      expect(libPanelBehavior.state.name).toBe('changed name');
      expect(panel.state.title).toBe('changed title');
      expect((gridItem.state.body as VizPanel).state.title).toBe('changed title');
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

interface SetupOptions {
  isNewPanel?: boolean;
  pluginSkipDataQuery?: boolean;
  repeatByVariable?: string;
  skipWait?: boolean;
  pluginLoadTime?: number;
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

  panelEditor.debounceSaveModelDiff = false;

  deactivate = activateFullSceneTree(dashboard);

  if (!options.skipWait) {
    //console.log('pluginResolve(pluginToLoad)');
    pluginResolve(pluginToLoad);
    await new Promise((r) => setTimeout(r, 1));
  }

  return { dashboard, panel, gridItem, panelEditor, pluginResolve };
}
