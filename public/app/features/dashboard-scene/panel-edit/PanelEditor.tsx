import * as H from 'history';
import { debounce } from 'lodash';
import { Unsubscribable } from 'rxjs';

import { LoadingState, NavIndex, PanelPlugin } from '@grafana/data';
import { t } from '@grafana/i18n';
import { config, locationService } from '@grafana/runtime';
import {
  NewSceneObjectAddedEvent,
  PanelBuilders,
  SceneComponentProps,
  SceneDataTransformer,
  SceneObjectBase,
  SceneObjectRef,
  SceneObjectState,
  SceneObjectStateChangedEvent,
  SceneQueryRunner,
  VizPanel,
} from '@grafana/scenes';
import { Panel } from '@grafana/schema';
import { OptionFilter } from 'app/features/dashboard/components/PanelEditor/OptionsPaneOptions';
import { getLastUsedDatasourceFromStorage } from 'app/features/dashboard/utils/dashboard';
import { saveLibPanel } from 'app/features/library-panels/state/api';
import { MIXED_DATASOURCE_NAME } from 'app/plugins/datasource/mixed/MixedDataSource';

import { DashboardEditActionEvent } from '../edit-pane/shared';
import { DashboardSceneChangeTracker } from '../saving/DashboardSceneChangeTracker';
import { getPanelChanges } from '../saving/getDashboardChanges';
import { DashboardSceneQueryRunner } from '../scene/DashboardSceneQueryRunner';
import { UNCONFIGURED_PANEL_PLUGIN_ID } from '../scene/UnconfiguredPanel';
import { DashboardGridItem } from '../scene/layout-default/DashboardGridItem';
import { DashboardLayoutItem, isDashboardLayoutItem } from '../scene/types/DashboardLayoutItem';
import { vizPanelToPanel } from '../serialization/transformSceneToSaveModel';
import {
  activateSceneObjectAndParentTree,
  findVizPanelByKey,
  getDashboardSceneFor,
  getDefaultVizPanel,
  getLibraryPanelBehavior,
  getPanelIdForVizPanel,
  getQueryRunnerFor,
} from '../utils/utils';

import { DataProviderSharer } from './PanelDataPane/DataProviderSharer';
import { PanelDataPane } from './PanelDataPane/PanelDataPane';
import { PanelDataPaneNext } from './PanelEditNext/PanelDataPaneNext';
import { PanelEditorRendererNext } from './PanelEditNext/PanelEditorRendererNext';
import { PanelEditorRenderer } from './PanelEditorRenderer';
import { PanelOptionsPane } from './PanelOptionsPane';

export interface PanelEditorState extends SceneObjectState {
  isNewPanel: boolean;
  isDirty?: boolean;
  optionsPane?: PanelOptionsPane;
  dataPane?: PanelDataPane | PanelDataPaneNext;
  panelRef: SceneObjectRef<VizPanel>;
  showLibraryPanelSaveModal?: boolean;
  showLibraryPanelUnlinkModal?: boolean;
  editPreview?: VizPanel;
  tableView?: VizPanel;
  pluginLoadErrror?: string;
  /**
   * Waiting for library panel or panel plugin to load
   */
  isInitializing?: boolean;
  /**
   * Enable the v2 query editor experience
   */
  useQueryExperienceNext?: boolean;
}

export class PanelEditor extends SceneObjectBase<PanelEditorState> {
  static Component = ({ model }: SceneComponentProps<PanelEditor>) => {
    const { useQueryExperienceNext } = model.useState();
    return useQueryExperienceNext ? <PanelEditorRendererNext model={model} /> : <PanelEditorRenderer model={model} />;
  };

  private _layoutItemState?: SceneObjectState;
  private _layoutItem: DashboardLayoutItem;
  private _originalSaveModel!: Panel;
  private _changesHaveBeenMade = false;
  private _editorDataTransformer?: SceneDataTransformer;
  private _editorQueryRunner?: SceneQueryRunner;

  public constructor(state: PanelEditorState) {
    super(state);

    const panel = this.state.panelRef.resolve();
    const layoutItem = panel.parent;
    if (!layoutItem || !isDashboardLayoutItem(layoutItem)) {
      throw new Error('Panel must have a parent of type DashboardLayoutItem');
    }

    this._layoutItem = layoutItem;

    this.setOriginalState(this.state.panelRef);
    this.addActivationHandler(this._activationHandler.bind(this));
  }

  private _activationHandler() {
    const panel = this.state.panelRef.resolve();
    const dashboard = getDashboardSceneFor(this);
    const queryRunner = getQueryRunnerFor(panel);
    const hasCompactData =
      queryRunner?.state.data?.compactSeries !== undefined ||
      queryRunner?.state.data?.request?.preferredQueryResultFormat === 'compact-v1';

    this.ensureEditorDataTransformer(panel);

    // Clear any panel selection when entering panel edit mode.
    // Need to clear selection here since selection is activated when panel edit mode is entered through the panel actions menu. This causes sidebar panel editor to be open when exiting panel edit mode
    dashboard.state.editPane.clearSelection();

    // this will be deleted when suggestions is fully rolled out.
    if (panel.state.pluginId === UNCONFIGURED_PANEL_PLUGIN_ID && !config.featureToggles.newVizSuggestions) {
      panel.changePluginType('timeseries');
    }

    this._subs.add(
      this._layoutItem.subscribeToEvent(DashboardEditActionEvent, ({ payload }) => {
        // TODO add support for undo/redo within panel edit
        payload.perform();
      })
    );

    let activeRunner: SceneQueryRunner | undefined;
    let runnerSubscription: Unsubscribable | undefined;
    let activeTransformer: SceneDataTransformer | undefined;
    let transformerSubscription: Unsubscribable | undefined;
    let pendingFormat: 'compact-v1' | 'full' | undefined;
    let suppressQueryFormatReconciliation = false;

    // Invariant: after the panel configuration settles, the latest prepared request and the
    // network request it starts use compact-v1 whenever that final configuration supports it.
    const reconcileQueryFormat = (currentRunner: SceneQueryRunner) => {
      if (suppressQueryFormatReconciliation || currentRunner !== getQueryRunnerFor(panel)) {
        return;
      }

      if (panel.getPlugin()?.meta.skipDataQuery) {
        pendingFormat = undefined;
        return;
      }

      const datasource = currentRunner.state.datasource;
      const isMixedDatasource = datasource?.type === 'mixed' || datasource?.uid === MIXED_DATASOURCE_NAME;
      const requiredFormat =
        !isMixedDatasource && dashboard.enrichDataRequest(currentRunner).preferredQueryResultFormat === 'compact-v1'
          ? 'compact-v1'
          : 'full';
      const currentData = currentRunner.state.data;
      const preparedRequest =
        currentRunner instanceof DashboardSceneQueryRunner ? currentRunner.getLastPreparedRequest() : undefined;
      const latestRequest = preparedRequest ?? currentData?.request;
      const requestIsInFlight =
        currentData?.state === LoadingState.Loading || currentData?.state === LoadingState.Streaming;
      let currentFormat: 'compact-v1' | 'full' | undefined;
      if (latestRequest) {
        currentFormat = latestRequest.preferredQueryResultFormat === 'compact-v1' ? 'compact-v1' : 'full';
      } else if (currentData?.compactSeries !== undefined) {
        currentFormat = 'compact-v1';
      } else if (currentData && !requestIsInFlight) {
        currentFormat = 'full';
      }
      const hasUnknownInFlightRequest = latestRequest === undefined && requestIsInFlight;

      if (hasUnknownInFlightRequest) {
        return;
      }

      if (currentFormat === requiredFormat) {
        pendingFormat = undefined;
        return;
      }

      if (!currentFormat || pendingFormat === requiredFormat) {
        return;
      }

      const replacementData =
        currentData && (requestIsInFlight || (requiredFormat === 'full' && currentData.compactSeries !== undefined))
          ? {
              ...currentData,
              state: LoadingState.Loading,
              compactSeries: requiredFormat === 'full' ? undefined : currentData.compactSeries,
            }
          : undefined;
      pendingFormat = requiredFormat;
      currentRunner.cancelQuery();
      if (replacementData) {
        currentRunner.setState({ data: replacementData });
      }
      currentRunner.runQueries();
    };

    const reconcileTransformationChange = (currentRunner: SceneQueryRunner) => {
      if (!(currentRunner instanceof DashboardSceneQueryRunner)) {
        reconcileQueryFormat(currentRunner);
        return;
      }

      const runQueriesRevision = currentRunner.getRunQueriesRevision();
      queueMicrotask(() => {
        const latestRunner = getQueryRunnerFor(panel);
        if (
          !this.isActive ||
          !latestRunner ||
          !Object.is(currentRunner, latestRunner) ||
          currentRunner.getRunQueriesRevision() !== runQueriesRevision
        ) {
          return;
        }
        reconcileQueryFormat(latestRunner);
      });
    };

    const updateRunner = () => {
      const currentRunner = getQueryRunnerFor(panel);
      if (currentRunner === activeRunner) {
        return currentRunner;
      }

      runnerSubscription?.unsubscribe();
      activeRunner = currentRunner;
      pendingFormat = undefined;
      if (currentRunner) {
        runnerSubscription = currentRunner.subscribeToState((newState, previousState) => {
          if (newState.data !== previousState.data) {
            reconcileQueryFormat(currentRunner);
          }
        });
        this._subs.add(runnerSubscription);
      }
      return currentRunner;
    };

    const updateTransformer = () => {
      const dataProvider = panel.state.$data;
      const currentTransformer = dataProvider instanceof SceneDataTransformer ? dataProvider : undefined;
      if (currentTransformer === activeTransformer) {
        return;
      }

      transformerSubscription?.unsubscribe();
      activeTransformer = currentTransformer;
      if (currentTransformer) {
        transformerSubscription = currentTransformer.subscribeToState((newState, previousState) => {
          if (newState.transformations !== previousState.transformations || newState.$data !== previousState.$data) {
            const currentRunner = updateRunner();
            if (currentRunner) {
              reconcileTransformationChange(currentRunner);
            }
          }
        });
        this._subs.add(transformerSubscription);
      }
    };

    updateRunner();
    updateTransformer();
    this._subs.add(
      panel.subscribeToState((newState, previousState) => {
        const compatibilityChanged =
          newState.pluginId !== previousState.pluginId ||
          newState.options !== previousState.options ||
          newState.fieldConfig !== previousState.fieldConfig ||
          newState.$data !== previousState.$data;
        if (!compatibilityChanged) {
          return;
        }

        if (newState.$data !== previousState.$data) {
          updateTransformer();
        }
        const currentRunner = updateRunner();
        if (currentRunner) {
          reconcileQueryFormat(currentRunner);
        }
      })
    );

    const deactivateParents = activateSceneObjectAndParentTree(panel);
    if (queryRunner && (hasCompactData || queryRunner.state.data?.state === LoadingState.Loading)) {
      suppressQueryFormatReconciliation = true;
      try {
        queryRunner.cancelQuery();
        queryRunner.runQueries();
      } finally {
        suppressQueryFormatReconciliation = false;
      }
    } else {
      const currentRunner = updateRunner();
      if (currentRunner) {
        reconcileQueryFormat(currentRunner);
      }
    }

    this.waitForPlugin();

    return () => {
      this.commitChanges();

      if (deactivateParents) {
        deactivateParents();
      }

      this.restoreEditorDataSource(panel);
    };
  }

  private ensureEditorDataTransformer(panel: VizPanel) {
    const queryRunner = getQueryRunnerFor(panel);
    if (!queryRunner || panel.state.$data !== queryRunner) {
      return;
    }

    queryRunner.clearParent();
    const transformer = new SceneDataTransformer({
      $data: queryRunner,
      transformations: [],
    });
    this._editorDataTransformer = transformer;
    this._editorQueryRunner = queryRunner;
    panel.setState({ $data: transformer });
  }

  private restoreEditorDataSource(panel: VizPanel) {
    const transformer = this._editorDataTransformer;
    const queryRunner = this._editorQueryRunner;
    if (!transformer || !queryRunner) {
      return;
    }

    if (panel.state.$data === transformer && transformer.state.transformations.length === 0) {
      queryRunner.clearParent();
      panel.setState({ $data: queryRunner });
      transformer.clearParent();
    } else if (panel.state.$data !== transformer) {
      transformer.clearParent();
    }

    this._editorDataTransformer = undefined;
    this._editorQueryRunner = undefined;
  }

  private commitChanges() {
    if (!this.state.isDirty && !this._changesHaveBeenMade) {
      // Nothing to commit
      return;
    }

    const layoutItem = this._layoutItem;
    const changedState = layoutItem.state;
    const originalState = this._layoutItemState!;

    this.setState({ editPreview: undefined });

    // Temp fix for old edit mode
    if (this._layoutItem instanceof DashboardGridItem && !config.featureToggles.dashboardNewLayouts) {
      this._layoutItem.handleEditChange();
      return;
    }

    const editAction = new DashboardEditActionEvent({
      description: t('dashboard.edit-actions.panel-edit', 'Panel changes'),
      source: this._layoutItem,
      perform: () => {
        // Because panel edit makes changes directly to layout item & panel
        // we only need to do this in case we want to re-perform after undo
        if (layoutItem.state !== changedState) {
          layoutItem.setState(changedState);
        }
      },
      undo: () => layoutItem!.setState(originalState),
    });

    // sadly we cannot publish this event directly here as the main dashboard edit / undo system
    // is not active while panel edit is active so we have to let the edit pane (which owns undo/redo)
    // publish this event when it activates
    const dashboard = getDashboardSceneFor(this);
    dashboard.state.editPane.setPanelEditAction(editAction);
  }

  private waitForPlugin(retry = 0) {
    if (!this.isActive) {
      return;
    }

    const panel = this.getPanel();
    const plugin = panel.getPlugin();

    if (!plugin || plugin.meta.id !== panel.state.pluginId) {
      if (retry < 100) {
        setTimeout(() => this.waitForPlugin(retry + 1), retry * 10);
      } else {
        this.setState({ pluginLoadErrror: 'Failed to load panel plugin' });
      }
      return;
    }

    this.gotPanelPlugin(plugin);
  }

  private setOriginalState(panelRef: SceneObjectRef<VizPanel>) {
    const panel = panelRef.resolve();
    const transformer = this._editorDataTransformer;
    const shouldUnwrapSnapshot =
      transformer !== undefined && panel.state.$data === transformer && transformer.state.transformations.length === 0;

    this._originalSaveModel = vizPanelToPanel(panel);
    const layoutItemClone = this._layoutItem.clone();
    const clonedPanel = findVizPanelByKey(layoutItemClone, panel.state.key);

    if (shouldUnwrapSnapshot && clonedPanel) {
      const clonedTransformer = clonedPanel?.state.$data;
      if (clonedTransformer instanceof SceneDataTransformer && clonedTransformer.state.$data) {
        const clonedQueryRunner = clonedTransformer.state.$data;
        clonedQueryRunner.clearParent();
        clonedPanel.setState({ $data: clonedQueryRunner });
        clonedTransformer.clearParent();
      }
    }

    clonedPanel?.clearParent();
    this._layoutItemState = layoutItemClone.state;
  }

  /**
   * Useful for testing to turn on debounce
   */
  public debounceSaveModelDiff = true;

  /**
   * Subscribe to state changes and check if the save model has changed
   */
  private _setupChangeDetection() {
    const panel = this.state.panelRef.resolve();
    const performSaveModelDiff = () => {
      const { hasChanges } = getPanelChanges(this._originalSaveModel, vizPanelToPanel(panel));
      this.setState({ isDirty: hasChanges });
    };

    const performSaveModelDiffDebounced = this.debounceSaveModelDiff
      ? debounce(performSaveModelDiff, 250)
      : performSaveModelDiff;

    const handleStateChange = (event: SceneObjectStateChangedEvent) => {
      if (DashboardSceneChangeTracker.isUpdatingPersistedState(event)) {
        performSaveModelDiffDebounced();
      }
    };

    // Subscribe to state changes on the parent (layout item) so we do not miss state changes on the layout item
    this._subs.add(this._layoutItem.subscribeToEvent(SceneObjectStateChangedEvent, handleStateChange));
  }

  public getPanel(): VizPanel {
    return this.state.panelRef?.resolve();
  }

  private gotPanelPlugin(plugin: PanelPlugin) {
    const panel = this.getPanel();

    // First time initialization
    if (this.state.isInitializing) {
      this.setOriginalState(this.state.panelRef);
      this._setupChangeDetection();
      this._updateDataPane(plugin);

      // Listen for panel plugin changes
      this._subs.add(
        panel.subscribeToState((n, p) => {
          if (n.pluginId !== p.pluginId) {
            this.waitForPlugin();
          }
        })
      );

      // Setup options pane
      const optionsPane = new PanelOptionsPane({
        panelRef: this.state.panelRef,
        editPreviewRef: this.state.editPreview?.getRef(),
        searchQuery: '',
        listMode: OptionFilter.All,
        isVizPickerOpen: this.state.isNewPanel,
        isNewPanel: this.state.isNewPanel,
      });

      this.setState({
        optionsPane,
        isInitializing: false,
      });

      this._subs.add(
        this.subscribeToState((newState, oldState) => {
          if (newState.editPreview !== oldState.editPreview) {
            optionsPane.setState({ editPreviewRef: newState.editPreview?.getRef() });
          }
        })
      );
      this._subs.add(
        optionsPane.subscribeToState((newState, oldState) => {
          if (newState.isVizPickerOpen !== oldState.isVizPickerOpen) {
            if (newState.isVizPickerOpen) {
              const panel = this.state.panelRef.resolve();
              const editPreview = PanelEditor.buildEditPreview(panel);
              this.setState({ editPreview });
            } else {
              this.setState({ editPreview: undefined });
            }
          }
        })
      );
    } else {
      // plugin changed after first time initialization
      // Just update data pane
      this._updateDataPane(plugin);
    }
  }

  private _updateDataPane(plugin: PanelPlugin) {
    const skipDataQuery = plugin.meta.skipDataQuery;

    const panel = this.state.panelRef.resolve();

    if (skipDataQuery) {
      if (this.state.dataPane) {
        locationService.partial({ tab: null }, true);
        this.setState({ dataPane: undefined });
      }

      // clean up data provider when switching from data to non data panel
      if (panel.state.$data) {
        panel.setState({ $data: undefined });
      }
    }

    if (!skipDataQuery) {
      if (!this.state.dataPane) {
        const dataPane = PanelDataPane.createFor(this.getPanel(), this.state.useQueryExperienceNext);
        this.setState({ dataPane });
        // This is to notify UrlSyncManager that a new object has been added to scene that requires url sync
        this.publishEvent(new NewSceneObjectAddedEvent(dataPane), true);
      }

      // add data provider when switching from non data to data panel
      if (!panel.state.$data) {
        let ds = getLastUsedDatasourceFromStorage(getDashboardSceneFor(this).state.uid!)?.datasourceUid;
        if (!ds) {
          ds = config.defaultDatasource;
        }

        panel.setState({
          $data: new SceneDataTransformer({
            $data: new DashboardSceneQueryRunner({
              datasource: {
                uid: ds,
              },
              queries: [{ refId: 'A' }],
            }),
            transformations: [],
          }),
        });
      }
    }
  }

  public getUrlKey() {
    return this.getPanelId().toString();
  }

  public getPanelId() {
    return getPanelIdForVizPanel(this.state.panelRef.resolve());
  }

  public getPageNav(location: H.Location, navIndex: NavIndex) {
    const dashboard = getDashboardSceneFor(this);

    return {
      text: t('dashboard-scene.panel-editor.text.edit-panel', 'Edit panel'),
      parentItem: dashboard.getPageNav(location, navIndex),
    };
  }

  public onDiscard = () => {
    this.setState({ isDirty: false });

    const panel = this.state.panelRef.resolve();

    if (this.state.isNewPanel) {
      getDashboardSceneFor(this).removePanel(panel);
    } else {
      // Revert any layout element changes
      this._layoutItem!.setState(this._layoutItemState!);
    }

    locationService.partial({ editPanel: null });
  };

  public dashboardSaved() {
    this.setOriginalState(this.state.panelRef);
    this.setState({ isDirty: false });

    // Remember that we have done changes
    this._changesHaveBeenMade = true;
  }

  public onSaveLibraryPanel = () => {
    this.setState({ showLibraryPanelSaveModal: true });
  };

  public onConfirmSaveLibraryPanel = () => {
    saveLibPanel(this.state.panelRef.resolve());
    this.setState({ isDirty: false });
    locationService.partial({ editPanel: null });
  };

  public onDismissLibraryPanelSaveModal = () => {
    this.setState({ showLibraryPanelSaveModal: false });
  };

  public onUnlinkLibraryPanel = () => {
    this.setState({ showLibraryPanelUnlinkModal: true });
  };

  public onDismissUnlinkLibraryPanelModal = () => {
    this.setState({ showLibraryPanelUnlinkModal: false });
  };

  public onConfirmUnlinkLibraryPanel = () => {
    const libPanelBehavior = getLibraryPanelBehavior(this.getPanel());
    if (!libPanelBehavior) {
      return;
    }

    libPanelBehavior.unlink();

    this.setState({ showLibraryPanelUnlinkModal: false });
  };

  public onToggleTableView = () => {
    if (this.state.tableView) {
      this.setState({ tableView: undefined });
      return;
    }

    const panel = this.state.panelRef.resolve();
    const dataProvider = panel.state.$data;
    if (!dataProvider) {
      return;
    }

    this.setState({
      tableView: PanelBuilders.table()
        .setTitle('')
        .setOption('showTypeIcons', true)
        .setOption('showHeader', true)
        .setData(new DataProviderSharer({ source: dataProvider.getRef() }))
        .build(),
    });
  };

  /**
   * Toggle between v1 and v2 query editor.
   */
  public onToggleQueryEditorVersion = () => {
    const newUseQueryExperienceNext = !this.state.useQueryExperienceNext;
    const dataPane = PanelDataPane.createFor(this.getPanel(), newUseQueryExperienceNext);

    this.setState({
      useQueryExperienceNext: newUseQueryExperienceNext,
      dataPane,
    });

    // This is to notify UrlSyncManager that a new object has been added to scene that requires url sync
    this.publishEvent(new NewSceneObjectAddedEvent(dataPane), true);
  };

  public static buildEditPreview(panel: VizPanel): VizPanel {
    const editPreview = getDefaultVizPanel();
    editPreview.setState({
      title: panel.state.title,
      description: panel.state.description,
      $data: panel.state.$data ? new DataProviderSharer({ source: panel.state.$data.getRef() }) : undefined,
    });
    return editPreview;
  }
}

export function buildPanelEditScene(panel: VizPanel, isNewPanel = false): PanelEditor {
  return new PanelEditor({
    useQueryExperienceNext: config.featureToggles.queryEditorNext,
    isInitializing: true,
    panelRef: panel.getRef(),
    isNewPanel,
    editPreview: isNewPanel ? PanelEditor.buildEditPreview(panel) : undefined,
  });
}
