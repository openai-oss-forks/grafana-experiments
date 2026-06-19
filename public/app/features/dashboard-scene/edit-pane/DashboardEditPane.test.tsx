import { config } from '@grafana/runtime';
import { SceneObjectBase, VizPanel, sceneGraph } from '@grafana/scenes';

import { DashboardScene } from '../scene/DashboardScene';
import { DefaultGridLayoutManager } from '../scene/layout-default/DefaultGridLayoutManager';
import { activateFullSceneTree } from '../utils/test-utils';

import { DashboardEditActionEvent } from './shared';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getDataSourceSrv: () => {
    return {
      getInstanceSettings: (uid: string) => ({}),
    };
  },
}));

describe('DashboardEditPane', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('Handles edit action events that adds objects', () => {
    const scene = buildTestScene();
    const editPane = scene.state.editPane;

    scene.onCreateNewPanel();

    expect(editPane.state.undoStack).toHaveLength(1);

    // Should select object
    expect(editPane.getSelection()).toBeDefined();

    editPane.undoAction();

    expect(editPane.state.undoStack).toHaveLength(0);

    // should clear selection
    expect(editPane.getSelection()).toBeUndefined();
  });

  it('when new action comes in clears redo stack', () => {
    const scene = buildTestScene();
    const editPane = scene.state.editPane;

    scene.onCreateNewPanel();

    editPane.undoAction();

    expect(editPane.state.redoStack).toHaveLength(1);

    scene.onCreateNewPanel();

    expect(editPane.state.redoStack).toHaveLength(0);
  });

  it('clone should not include undo/redo history', () => {
    const scene = buildTestScene();
    const editPane = scene.state.editPane;

    scene.onCreateNewPanel();
    scene.onCreateNewPanel();

    editPane.undoAction();

    expect(editPane.state.redoStack).toHaveLength(1);
    expect(editPane.state.undoStack).toHaveLength(1);

    const cloned = editPane.clone({});

    expect(cloned.state.redoStack).toHaveLength(0);
    expect(cloned.state.undoStack).toHaveLength(0);
  });

  it('resolves panel edit publication only after its source is active', async () => {
    jest.useFakeTimers();
    const scene = buildTestScene();
    const source = new TestSceneObject({ key: 'inactive-source' });
    jest.spyOn(sceneGraph, 'findObject').mockReturnValue(source);
    const publishEvent = jest.spyOn(source, 'publishEvent');
    const action = new DashboardEditActionEvent({
      source,
      perform: jest.fn(),
      undo: jest.fn(),
    });
    let published = false;
    const publication = scene.state.editPane.performPanelEditAction(action).then(() => {
      published = true;
    });

    expect(published).toBe(false);
    expect(publishEvent).not.toHaveBeenCalled();

    const deactivateSource = activateFullSceneTree(source);
    jest.runOnlyPendingTimers();
    await publication;

    expect(published).toBe(true);
    expect(publishEvent).toHaveBeenCalledWith(action, true);
    deactivateSource();
  });

  it('stops waiting when a panel edit source is detached', async () => {
    jest.useFakeTimers();
    const panel = new VizPanel({ key: 'detached-source', pluginId: 'text' });
    const scene = buildTestScene(panel, false);
    const source = panel.parent!;
    const publishEvent = jest.spyOn(source, 'publishEvent');
    const action = new DashboardEditActionEvent({
      source,
      perform: jest.fn(),
      undo: jest.fn(),
    });
    const publication = scene.state.editPane.performPanelEditAction(action);

    const layout = scene.state.body as DefaultGridLayoutManager;
    layout.state.grid.setState({ children: [] });
    expect(sceneGraph.findObject(scene, (candidate) => candidate === source)).toBeNull();
    jest.runOnlyPendingTimers();
    await publication;

    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('publishes after a bounded wait when an attached panel edit source cannot activate', async () => {
    jest.useFakeTimers();
    const scene = buildTestScene();
    const source = new TestSceneObject({ key: 'hidden-source' });
    jest.spyOn(sceneGraph, 'findObject').mockReturnValue(source);
    const publishEvent = jest.spyOn(source, 'publishEvent');
    const action = new DashboardEditActionEvent({
      source,
      perform: jest.fn(),
      undo: jest.fn(),
    });
    const publication = scene.state.editPane.performPanelEditAction(action);

    jest.runAllTimers();
    await publication;

    expect(publishEvent).toHaveBeenCalledWith(action, true);
  });
});

class TestSceneObject extends SceneObjectBase {}

function buildTestScene(panel?: VizPanel, activate = true) {
  const scene = new DashboardScene({
    title: 'hello',
    uid: 'dash-1',
    description: 'hello description',
    tags: ['tag1', 'tag2'],
    editable: true,
    ...(panel ? { body: DefaultGridLayoutManager.fromVizPanels([panel]) } : {}),
  });

  config.featureToggles.dashboardNewLayouts = true;

  if (activate) {
    activateFullSceneTree(scene);
  }

  return scene;
}
