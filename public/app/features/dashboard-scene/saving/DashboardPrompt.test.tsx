import { act, render } from '@testing-library/react';
import * as H from 'history';
import { TestProvider } from 'test/helpers/TestProvider';

import { locationService } from '@grafana/runtime';
import { SceneQueryRunner, SceneTimeRange, VizPanel, behaviors, sceneGraph } from '@grafana/scenes';
import { Dashboard } from '@grafana/schema';
import { Spec as DashboardV2Spec } from '@grafana/schema/apis/dashboard.grafana.app/v2';
import { ModalsContext } from '@grafana/ui';
import { ContextSrv, setContextSrv } from 'app/core/services/context_srv';
import { ObjectMeta } from 'app/features/apiserver/types';

import { buildPanelEditScene } from '../panel-edit/PanelEditor';
import { DashboardControls } from '../scene/DashboardControls';
import { DashboardScene, DashboardSceneState } from '../scene/DashboardScene';
import { LibraryPanelBehavior } from '../scene/LibraryPanelBehavior';
import { DefaultGridLayoutManager } from '../scene/layout-default/DefaultGridLayoutManager';
import { transformSceneToSaveModel } from '../serialization/transformSceneToSaveModel';

import { DashboardPrompt, ignoreChanges, isEmptyDashboard } from './DashboardPrompt';

let mockPromptMessage: ((location: H.Location) => boolean) | undefined;

jest.mock('app/core/components/FormPrompt/Prompt', () => ({
  Prompt: ({ message }: { message: (location: H.Location) => boolean }) => {
    mockPromptMessage = message;
    return null;
  },
}));

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  config: {
    ...jest.requireActual('@grafana/runtime').config,
    defaultDatasource: 'gdev-testdata',
    datasources: {
      'gdev-testdata': {
        id: 1,
        uid: 'gdev-testdata',
        type: 'grafana-testdata-datasource',
        name: 'gdev-testdata',
        meta: {
          id: 'grafana-testdata-datasource',
          type: 'datasource',
          name: 'TestData',
        },
      },
      '-- Grafana --': {
        id: -1,
        uid: 'grafana',
        type: 'datasource',
        name: '-- Grafana --',
        meta: {
          id: 'grafana',
          type: 'datasource',
          name: '-- Grafana --',
        },
      },
    },
  },
}));

function getTestContext() {
  const contextSrv = { isSignedIn: true, isEditor: true } as ContextSrv;
  setContextSrv(contextSrv);

  return { contextSrv };
}

describe('DashboardPrompt', () => {
  beforeEach(() => {
    mockPromptMessage = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('blocks beforeunload while a panel edit completion is pending', () => {
    const scene = buildTestScene();
    let finishPanelEdit!: () => void;
    scene.setPendingPanelEditCompletion(
      new Promise<void>((resolve) => {
        finishPanelEdit = resolve;
      })
    );
    const { unmount } = renderDashboardPrompt(scene);
    const event = new Event('beforeunload', { cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    finishPanelEdit();
    unmount();
  });

  it('waits for a library panel save before replaying navigation', async () => {
    jest.useFakeTimers();
    const initialLocation = locationService.getLocation();
    locationService.replace({ ...initialLocation, search: '?editPanel=1' });
    const scene = buildTestScene();
    const panelEditor = addLibraryPanelEditor(scene);
    let finishLibrarySave!: () => void;
    const librarySave = new Promise<boolean>((resolve) => {
      finishLibrarySave = () => resolve(true);
    });
    jest.spyOn(panelEditor, 'getPendingLibraryPanelSave').mockReturnValue(librarySave);
    const pushSpy = jest.spyOn(locationService, 'push').mockImplementation(() => undefined);
    const { unmount } = renderDashboardPrompt(scene);
    const nextLocation = buildLocation('/d/next');

    expect(mockPromptMessage?.(nextLocation)).toBe(false);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(mockPromptMessage?.(buildLocation(initialLocation.pathname))).toBe(true);

    await act(async () => {
      finishLibrarySave();
      await librarySave;
    });
    act(() => jest.advanceTimersByTime(10));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(nextLocation);
    unmount();
    locationService.replace(initialLocation);
  });

  it('lets a newer deferred navigation supersede an in-flight modal save', async () => {
    jest.useFakeTimers();
    const scene = buildTestScene();
    const panelEditor = addLibraryPanelEditor(scene);
    panelEditor.setState({ isDirty: true });
    let finishLibrarySave!: (saved: boolean) => void;
    let saveStarted = false;
    const librarySave = new Promise<boolean>((resolve) => {
      finishLibrarySave = resolve;
    });
    jest
      .spyOn(panelEditor, 'getPendingLibraryPanelSave')
      .mockImplementation(() => (saveStarted ? librarySave : undefined));
    jest.spyOn(panelEditor, 'onConfirmSaveLibraryPanel').mockImplementation(() => {
      saveStarted = true;
      return librarySave;
    });
    const pushSpy = jest.spyOn(locationService, 'push').mockImplementation(() => undefined);
    const { unmount, showModal } = renderDashboardPrompt(scene);
    const firstLocation = buildLocation('/d/first');
    const latestLocation = buildLocation('/d/latest');

    expect(mockPromptMessage?.(firstLocation)).toBe(false);
    const onConfirm = showModal.mock.calls[0][1].onConfirm as () => Promise<void>;
    const confirmation = onConfirm();
    expect(mockPromptMessage?.(latestLocation)).toBe(false);

    await act(async () => {
      finishLibrarySave(true);
      await Promise.all([librarySave, confirmation]);
    });
    act(() => jest.advanceTimersByTime(10));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(latestLocation);
    unmount();
  });

  it('preserves the blocked destination across the URL update after saving a new dashboard', () => {
    jest.useFakeTimers();
    getTestContext();
    const scene = buildTestScene({ isEditing: true });
    scene.setState({ meta: { ...scene.state.meta, canSave: true, version: 1 } });
    scene.setInitialSaveModel(transformSceneToSaveModel(scene));
    scene.setState({ isDirty: true, title: 'Changed title' });
    let onSaveSuccess: (() => void) | undefined;
    jest.spyOn(scene, 'openSaveDrawer').mockImplementation((options) => {
      onSaveSuccess = options.onSaveSuccess;
    });
    const pushSpy = jest.spyOn(locationService, 'push').mockImplementation(() => undefined);
    const { unmount, showModal } = renderDashboardPrompt(scene);
    const destination = buildLocation('/d/next');

    expect(mockPromptMessage?.(destination)).toBe(false);
    const onSaveDashboardClick = showModal.mock.calls[0][1].onSaveDashboardClick as () => void;
    onSaveDashboardClick();
    scene.setState({ isDirty: false, meta: { ...scene.state.meta, url: '/d/saved' } });
    onSaveSuccess?.();

    expect(mockPromptMessage?.(buildLocation('/d/saved'))).toBe(true);
    act(() => jest.advanceTimersByTime(10));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(destination);
    unmount();
  });

  it.each([
    ['replays the latest external navigation', false],
    ['drops a deferred navigation superseded by a same-dashboard navigation', true],
  ])('%s while a panel edit is pending', async (_name, supersededBySameDashboard) => {
    jest.useFakeTimers();
    const scene = buildTestScene();
    let finishPanelEdit!: () => void;
    scene.setPendingPanelEditCompletion(
      new Promise<void>((resolve) => {
        finishPanelEdit = resolve;
      })
    );
    const pushSpy = jest.spyOn(locationService, 'push').mockImplementation(() => undefined);
    const { unmount } = renderDashboardPrompt(scene);
    const firstLocation = buildLocation('/d/first');
    const latestLocation = buildLocation(
      supersededBySameDashboard ? locationService.getLocation().pathname : '/d/latest'
    );

    expect(mockPromptMessage?.(firstLocation)).toBe(false);
    expect(mockPromptMessage?.(latestLocation)).toBe(supersededBySameDashboard);

    await act(async () => {
      finishPanelEdit();
      await Promise.resolve();
    });
    act(() => jest.advanceTimersByTime(10));

    if (supersededBySameDashboard) {
      expect(pushSpy).not.toHaveBeenCalled();
    } else {
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).toHaveBeenCalledWith(latestLocation);
    }
    unmount();
  });

  it('does not replay a deferred navigation after unmount', async () => {
    jest.useFakeTimers();
    const scene = buildTestScene();
    let finishPanelEdit!: () => void;
    scene.setPendingPanelEditCompletion(
      new Promise<void>((resolve) => {
        finishPanelEdit = resolve;
      })
    );
    const pushSpy = jest.spyOn(locationService, 'push').mockImplementation(() => undefined);
    const { unmount } = renderDashboardPrompt(scene);

    expect(mockPromptMessage?.(buildLocation('/d/next'))).toBe(false);
    unmount();
    await act(async () => {
      finishPanelEdit();
      await Promise.resolve();
    });
    act(() => jest.advanceTimersByTime(10));

    expect(pushSpy).not.toHaveBeenCalled();
  });

  describe('ignoreChanges', () => {
    beforeEach(() => {
      getTestContext();
    });

    describe('when called without original dashboard', () => {
      it('then it should return true', () => {
        const scene = buildTestScene();
        scene.setInitialSaveModel(undefined);
        expect(ignoreChanges(scene)).toBe(true);
      });
    });

    describe('when called without current dashboard', () => {
      it('then it should return true', () => {
        expect(ignoreChanges(null)).toBe(true);
      });
    });

    describe('when called for a viewer without save permissions', () => {
      it('then it should return true', () => {
        const { contextSrv } = getTestContext();
        const scene = buildTestScene({
          meta: {
            canSave: false,
          },
        });
        contextSrv.isEditor = false;

        expect(ignoreChanges(scene)).toBe(true);
      });
    });

    describe('when called for a viewer with save permissions', () => {
      it('then it should return undefined', () => {
        const { contextSrv } = getTestContext();

        const scene = buildTestScene({
          meta: {
            canSave: true,
          },
        });
        const initialSaveModel = transformSceneToSaveModel(scene);
        scene.setInitialSaveModel(initialSaveModel);

        contextSrv.isEditor = false;

        expect(ignoreChanges(scene)).toBe(undefined);
      });
    });

    describe('when called for an user that is not signed in', () => {
      it('then it should return true', () => {
        const { contextSrv } = getTestContext();
        const scene = buildTestScene({
          meta: {
            canSave: true,
          },
        });
        const initialSaveModel = transformSceneToSaveModel(scene);
        scene.setInitialSaveModel(initialSaveModel);

        contextSrv.isSignedIn = false;
        expect(ignoreChanges(scene)).toBe(true);
      });
    });

    describe('when called with fromScript', () => {
      it('then it should return true', () => {
        const scene = buildTestScene({
          meta: {
            canSave: true,
            fromScript: true,
          },
        });
        const initialSaveModel = transformSceneToSaveModel(scene);
        scene.setInitialSaveModel(initialSaveModel);

        expect(ignoreChanges(scene)).toBe(true);
      });
    });

    describe('when called with fromFile', () => {
      it('then it should return true', () => {
        const scene = buildTestScene({
          meta: {
            canSave: true,
            fromScript: undefined,
            fromFile: true,
          },
        });
        const initialSaveModel = transformSceneToSaveModel(scene);
        scene.setInitialSaveModel(initialSaveModel);

        expect(ignoreChanges(scene)).toBe(true);
      });
    });

    describe('when called with canSave but without fromScript and fromFile', () => {
      it('then it should return false', () => {
        const scene = buildTestScene({
          meta: {
            canSave: true,
            fromScript: undefined,
            fromFile: undefined,
          },
        });
        const initialSaveModel = transformSceneToSaveModel(scene);
        scene.setInitialSaveModel(initialSaveModel);

        expect(ignoreChanges(scene)).toBe(undefined);
      });
    });
  });

  describe('isEmptyDashboard', () => {
    describe('Dashboard V1 tests', () => {
      describe('empty dashboard cases', () => {
        it('should return true for completely empty dashboard', () => {
          const emptyDashboard: Dashboard = {
            id: null,
            uid: '',
            title: '',
            tags: [],
            panels: [],
            schemaVersion: 16,
            version: 0,
            links: [],
            time: { from: 'now-6h', to: 'now' },
            timepicker: {},
            templating: { list: [] },
            annotations: { list: [] },
          };

          expect(isEmptyDashboard(emptyDashboard)).toBe(true);
        });

        it('should return true for dashboard with no panels, links, templates, or uid', () => {
          const scene = buildTestScene(
            {
              uid: '',
              body: DefaultGridLayoutManager.fromVizPanels([]),
            },
            'v1'
          );
          const dashboard = scene.getSaveModel() as Dashboard;
          dashboard.links = [];
          dashboard.templating = { list: [] };
          dashboard.uid = '';

          expect(isEmptyDashboard(dashboard)).toBe(true);
        });
      });

      describe('non-empty dashboard cases', () => {
        it('should return false for dashboard with panels', () => {
          const scene = buildTestScene();
          const dashboard = scene.getSaveModel();

          expect(isEmptyDashboard(dashboard)).toBe(false);
        });

        it('should return false for dashboard with links', () => {
          const scene = buildTestScene(
            {
              uid: '',
              body: DefaultGridLayoutManager.fromVizPanels([]),
              links: [
                {
                  title: 'Test Link',
                  url: 'https://example.com',
                  type: 'link',
                  icon: 'external link',
                  tooltip: '',
                  asDropdown: false,
                  tags: [],
                  includeVars: false,
                  keepTime: false,
                  targetBlank: false,
                },
              ],
            },
            'v1'
          );
          const dashboard = scene.getSaveModel() as Dashboard;
          dashboard.templating = { list: [] };

          expect(isEmptyDashboard(dashboard)).toBe(false);
        });

        it('should return false for dashboard with template variables', () => {
          const scene = buildTestScene(
            {
              uid: '',
              body: DefaultGridLayoutManager.fromVizPanels([]),
            },
            'v1'
          );
          const dashboard = scene.getSaveModel() as Dashboard;
          dashboard.links = [];
          dashboard.templating = {
            list: [
              {
                name: 'testVar',
                type: 'query',
                query: 'test query',
                current: { value: 'test', text: 'test' },
                options: [],
              },
            ],
          };

          expect(isEmptyDashboard(dashboard)).toBe(false);
        });

        it('should return false for dashboard with uid', () => {
          const scene = buildTestScene(
            {
              uid: 'test-uid-123',
              body: DefaultGridLayoutManager.fromVizPanels([]),
            },
            'v1'
          );
          const dashboard = scene.getSaveModel() as Dashboard;
          dashboard.links = [];
          dashboard.templating = { list: [] };

          expect(isEmptyDashboard(dashboard)).toBe(false);
        });
      });
    });

    describe('Dashboard V2 tests', () => {
      describe('empty dashboard cases', () => {
        it('should return true for completely empty dashboard v2', () => {
          const emptyDashboardV2: DashboardV2Spec = {
            title: '',
            tags: [],
            elements: {},
            layout: {
              kind: 'GridLayout',
              spec: {
                items: [],
              },
            },
            links: [],
            variables: [],
            annotations: [],
            timeSettings: {
              from: 'now-6h',
              to: 'now',
              timezone: 'browser',
              weekStart: 'monday',
              fiscalYearStartMonth: 0,
              autoRefreshIntervals: ['5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '2h', '1d'],
              autoRefresh: '5s',
              hideTimepicker: false,
            },
            cursorSync: 'Off',
            liveNow: false,
            preload: false,
          };
          const emptyMetadata: ObjectMeta = {
            name: '',
            resourceVersion: '1',
            creationTimestamp: '2023-01-01T00:00:00Z',
          };

          expect(isEmptyDashboard(emptyDashboardV2, emptyMetadata)).toBe(true);
        });

        it('should return true for dashboard v2 with no elements, links, variables, or name', () => {
          const scene = buildTestScene(
            {
              body: DefaultGridLayoutManager.fromVizPanels([]),
            },
            'v2'
          );
          const dashboard = scene.getSaveModel();
          const metadata: ObjectMeta = {
            name: '',
            resourceVersion: '1',
            creationTimestamp: '2023-01-01T00:00:00Z',
          };

          expect(isEmptyDashboard(dashboard, metadata)).toBe(true);
        });
      });

      describe('non-empty dashboard cases', () => {
        it('should return false for dashboard v2 with elements', () => {
          const scene = buildTestScene({}, 'v2');
          const dashboard = scene.getSaveModel();

          expect(isEmptyDashboard(dashboard)).toBe(false);
        });

        it('should return false for dashboard v2 with links', () => {
          const scene = buildTestScene(
            {
              body: DefaultGridLayoutManager.fromVizPanels([]),
              links: [
                {
                  title: 'Test Link V2',
                  url: 'https://example.com',
                  type: 'link',
                  icon: 'external link',
                  tooltip: '',
                  asDropdown: false,
                  tags: [],
                  includeVars: false,
                  keepTime: false,
                  targetBlank: false,
                },
              ],
            },
            'v2'
          );
          const dashboard = scene.getSaveModel();
          const metadata: ObjectMeta = {
            name: '',
            resourceVersion: '1',
            creationTimestamp: '2023-01-01T00:00:00Z',
          };

          expect(isEmptyDashboard(dashboard, metadata)).toBe(false);
        });

        it('should return false for dashboard v2 with variables', () => {
          const scene = buildTestScene(
            {
              body: DefaultGridLayoutManager.fromVizPanels([]),
            },
            'v2'
          );
          const dashboard = scene.getSaveModel() as DashboardV2Spec;
          dashboard.variables = [
            { kind: 'ConstantVariable', spec: { name: 'testVar' } } as DashboardV2Spec['variables'][number],
          ];
          const metadata: ObjectMeta = {
            name: '',
            resourceVersion: '1',
            creationTimestamp: '2023-01-01T00:00:00Z',
          };

          expect(isEmptyDashboard(dashboard, metadata)).toBe(false);
        });

        it('should return false for dashboard v2 with name in metadata', () => {
          const scene = buildTestScene(
            {
              body: DefaultGridLayoutManager.fromVizPanels([]),
            },
            'v2'
          );
          const dashboard = scene.getSaveModel();
          const metadata: ObjectMeta = {
            name: 'test-dashboard-with-name',
            resourceVersion: '1',
            creationTimestamp: '2023-01-01T00:00:00Z',
          };

          expect(isEmptyDashboard(dashboard, metadata)).toBe(false);
        });
      });
    });
  });
});

function buildLocation(pathname: string): H.Location {
  return { pathname, search: '', hash: '', state: undefined, key: pathname };
}

function renderDashboardPrompt(scene: DashboardScene) {
  const showModal = jest.fn();
  const view = render(
    <TestProvider>
      <ModalsContext.Provider value={{ component: null, props: {}, showModal, hideModal: jest.fn() }}>
        <DashboardPrompt dashboard={scene} />
      </ModalsContext.Provider>
    </TestProvider>
  );
  return { ...view, showModal };
}

function addLibraryPanelEditor(scene: DashboardScene) {
  const panel = sceneGraph.findObject(scene, (candidate) => candidate instanceof VizPanel);
  if (!(panel instanceof VizPanel)) {
    throw new Error('Expected dashboard panel');
  }
  panel.setState({
    $behaviors: [new LibraryPanelBehavior({ name: 'Library panel', uid: 'library-panel', isLoaded: true })],
  });
  const panelEditor = buildPanelEditScene(panel);
  scene.setState({ editPanel: panelEditor });
  return panelEditor;
}

function buildTestScene(overrides?: Partial<DashboardSceneState>, serializerVersion: 'v1' | 'v2' = 'v1') {
  const defaultPanels = [
    new VizPanel({
      title: 'Panel A',
      key: 'panel-1',
      pluginId: 'table',
      $data: new SceneQueryRunner({ key: 'data-query-runner', queries: [{ refId: 'A' }] }),
    }),
  ];

  const scene = new DashboardScene(
    {
      title: 'hello',
      uid: 'dash-1',
      description: 'hello description',
      tags: ['tag1', 'tag2'],
      editable: true,
      $timeRange: new SceneTimeRange({
        timeZone: 'browser',
      }),
      controls: new DashboardControls({}),
      $behaviors: [new behaviors.CursorSync({})],
      body: DefaultGridLayoutManager.fromVizPanels(defaultPanels),
      ...overrides,
    },
    serializerVersion
  );

  return scene;
}
