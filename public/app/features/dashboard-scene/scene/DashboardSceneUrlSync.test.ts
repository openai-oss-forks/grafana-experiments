import { SceneQueryRunner, VizPanel } from '@grafana/scenes';

import { DashboardScene } from './DashboardScene';
import { LibraryPanelBehavior } from './LibraryPanelBehavior';
import { DefaultGridLayoutManager } from './layout-default/DefaultGridLayoutManager';

describe('DashboardSceneUrlSync', () => {
  describe('Given a standard scene', () => {
    it('Should set UNSAFE_fitPanels when url has autofitpanels', () => {
      const scene = buildTestScene();
      scene.urlSync?.updateFromUrl({ autofitpanels: '' });
      const layout = scene.state.body as DefaultGridLayoutManager;

      expect(layout.state.grid.state.UNSAFE_fitPanels).toBe(true);
    });

    it('Should get the autofitpanels from the scene state', () => {
      const scene = buildTestScene();

      expect(scene.urlSync?.getUrlState().autofitpanels).toBeUndefined();
      const layout = scene.state.body as DefaultGridLayoutManager;
      layout.state.grid.setState({ UNSAFE_fitPanels: true });
      expect(scene.urlSync?.getUrlState().autofitpanels).toBe('true');
    });
  });

  describe('entering edit mode', () => {
    it('it should be possible to go from the view panel view to the edit view when the dashboard is not in edit mdoe', () => {
      const scene = buildTestScene();
      scene.setState({ isEditing: false });
      scene.urlSync?.updateFromUrl({ viewPanel: 'panel-1' });
      expect(scene.state.viewPanel).toBeDefined();
      scene.urlSync?.updateFromUrl({ editPanel: 'panel-1' });
      expect(scene.state.editPanel).toBeDefined();
    });

    it('lets edit panel win when view and edit are both present in the same URL update', () => {
      const scene = buildTestScene();

      scene.urlSync?.updateFromUrl({ viewPanel: 'panel-1', editPanel: 'panel-1' });

      expect(scene.state.editPanel).toBeDefined();
      expect(scene.state.viewPanel).toBeUndefined();
    });

    it('does not enter edit after an unloaded library panel request is cleared', () => {
      const libraryPanel = new LibraryPanelBehavior({ name: 'Library panel', uid: 'library-panel' });
      const scene = buildTestScene(libraryPanel);

      scene.urlSync?.updateFromUrl({ editPanel: 'panel-1' });
      expect(scene.state.editPanel).toBeUndefined();

      scene.urlSync?.updateFromUrl({ editPanel: null });
      libraryPanel.setState({ isLoaded: true });

      expect(scene.state.editPanel).toBeUndefined();
    });

    it('does not let an older library panel load replace a newer edit request', () => {
      const libraryPanel = new LibraryPanelBehavior({ name: 'Library panel', uid: 'library-panel' });
      const scene = buildTestScene(libraryPanel);

      scene.urlSync?.updateFromUrl({ editPanel: 'panel-1' });
      scene.urlSync?.updateFromUrl({ editPanel: 'panel-2' });
      libraryPanel.setState({ isLoaded: true });

      expect(scene.state.editPanel?.getUrlKey()).toBe('2');
    });
  });
});

function buildTestScene(libraryPanel?: LibraryPanelBehavior) {
  const scene = new DashboardScene({
    title: 'hello',
    uid: 'dash-1',
    body: DefaultGridLayoutManager.fromVizPanels([
      new VizPanel({
        title: 'Panel A',
        key: 'panel-1',
        pluginId: 'table',
        $behaviors: libraryPanel ? [libraryPanel] : undefined,
        $data: new SceneQueryRunner({ key: 'data-query-runner', queries: [{ refId: 'A' }] }),
      }),

      new VizPanel({
        title: 'Panel B',
        key: 'panel-2',
        pluginId: 'table',
      }),
    ]),
  });

  return scene;
}
