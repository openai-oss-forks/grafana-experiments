import { css } from '@emotion/css';
import * as H from 'history';
import { memo, useContext, useEffect, useMemo, useRef } from 'react';

import { Trans, t } from '@grafana/i18n';
import { locationService } from '@grafana/runtime';
import { Dashboard } from '@grafana/schema';
import { Spec as DashboardV2Spec } from '@grafana/schema/apis/dashboard.grafana.app/v2';
import { ModalsContext, Modal, Button, useStyles2 } from '@grafana/ui';
import { Prompt } from 'app/core/components/FormPrompt/Prompt';
import { contextSrv } from 'app/core/services/context_srv';
import { ObjectMeta } from 'app/features/apiserver/types';
import { isDashboardV2Spec } from 'app/features/dashboard/api/utils';
import { DASHBOARD_LIBRARY_ROUTES } from 'app/features/dashboard/dashgrid/types';
import { DashboardMeta } from 'app/types/dashboard';

import { SaveLibraryVizPanelModal } from '../panel-edit/SaveLibraryVizPanelModal';
import { DashboardScene } from '../scene/DashboardScene';
import { getLibraryPanelBehavior, hasActualSaveChanges, isLibraryPanel } from '../utils/utils';

interface DashboardPromptProps {
  dashboard: DashboardScene;
}

export const DashboardPrompt = memo(({ dashboard }: DashboardPromptProps) => {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const originalLocation = useMemo(() => locationService.getLocation(), [dashboard]);
  const originalPath = useMemo(() => originalLocation.pathname, [originalLocation]);
  const { showModal, hideModal } = useContext(ModalsContext);
  const deferredNavigationIntent = useRef(0);

  useEffect(() => {
    const handleUnload = (event: BeforeUnloadEvent) => {
      if (
        dashboard.hasPendingPanelEditCompletion() ||
        dashboard.state.editPanel?.getPendingPanelChange() ||
        dashboard.state.editPanel?.getPendingLibraryPanelSave()
      ) {
        event.preventDefault();
        event.returnValue = '';
        return;
      }

      if (ignoreChanges(dashboard)) {
        return;
      }

      if (dashboard.state.isDirty || dashboard.state.editPanel?.hasChanges()) {
        event.preventDefault();
        // No browser actually displays this message anymore.
        // But Chrome requires it to be defined else the popup won't show.
        event.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      deferredNavigationIntent.current += 1;
    };
  }, [dashboard]);

  const onHistoryBlock = (location: H.Location) => {
    const panelEditor = dashboard.state.editPanel;
    const vizPanel = panelEditor?.getPanel();
    const search = new URLSearchParams(location.search);
    const pendingPanelChange = panelEditor?.getPendingPanelChange();
    const pendingLibraryPanelSave = panelEditor?.getPendingLibraryPanelSave();
    const pendingPanelEditCompletion = dashboard.hasPendingPanelEditCompletion()
      ? dashboard.waitForPendingPanelEditCompletion()
      : undefined;
    const pendingNavigation: Array<Promise<unknown>> = [];
    if (pendingPanelChange) {
      pendingNavigation.push(pendingPanelChange);
    }
    if (pendingLibraryPanelSave) {
      pendingNavigation.push(pendingLibraryPanelSave);
    }
    if (pendingPanelEditCompletion) {
      pendingNavigation.push(pendingPanelEditCompletion);
    }
    const isExternalNavigation = originalPath !== location.pathname;
    const isLeavingLibraryPanel = Boolean(vizPanel && isLibraryPanel(vizPanel) && !search.has('editPanel'));
    const isLeavingChangedLibraryPanel = Boolean(
      isLeavingLibraryPanel && panelEditor && (panelEditor.state.isDirty || panelEditor.hasChanges())
    );

    if (pendingNavigation.length > 0 && (isExternalNavigation || isLeavingChangedLibraryPanel)) {
      const navigationIntent = ++deferredNavigationIntent.current;
      void Promise.all(pendingNavigation).then(() => {
        moveToBlockedLocationAfterReactStateUpdate(
          location,
          false,
          () => deferredNavigationIntent.current === navigationIntent
        );
      });
      return false;
    }

    const navigationIntent =
      isExternalNavigation || isLeavingChangedLibraryPanel ? ++deferredNavigationIntent.current : undefined;
    const isCurrentNavigation = () =>
      navigationIntent === undefined || deferredNavigationIntent.current === navigationIntent;

    // Are we leaving panel edit & library panel?
    if (panelEditor && vizPanel && isLibraryPanel(vizPanel) && isLeavingChangedLibraryPanel) {
      const libPanelBehavior = getLibraryPanelBehavior(vizPanel);

      showModal(SaveLibraryVizPanelModal, {
        dashboard,
        isUnsavedPrompt: true,
        isSaving: panelEditor.state.isLibraryPanelSaving,
        libraryPanel: libPanelBehavior!,
        onConfirm: async () => {
          const saved = await panelEditor.onConfirmSaveLibraryPanel(false);
          if (!saved) {
            return;
          }
          hideModal();
          moveToBlockedLocationAfterReactStateUpdate(location, false, isCurrentNavigation);
        },
        onDiscard: () => {
          if (!panelEditor.onDiscard()) {
            return;
          }
          hideModal();
          moveToBlockedLocationAfterReactStateUpdate(location, false, isCurrentNavigation);
        },
        onDismiss: hideModal,
      });
      return false;
    }

    // Are we still on the same dashboard?
    if (originalPath === location.pathname) {
      return true;
    }

    if (ignoreChanges(dashboard)) {
      return true;
    }

    if (!dashboard.state.isDirty && !panelEditor?.hasChanges()) {
      return true;
    }

    showModal(UnsavedChangesModal, {
      dashboard,
      onSaveDashboardClick: () => {
        hideModal();
        dashboard.openSaveDrawer({
          onSaveSuccess: () => {
            moveToBlockedLocationAfterReactStateUpdate(location, false, isCurrentNavigation);
          },
        });
      },

      onDiscard: () => {
        dashboard.exitEditMode({ skipConfirm: true });
        hideModal();
        if (originalPath === DASHBOARD_LIBRARY_ROUTES.Template) {
          moveToBlockedLocationAfterReactStateUpdate(location, true, isCurrentNavigation);
        } else {
          moveToBlockedLocationAfterReactStateUpdate(location, false, isCurrentNavigation);
        }
      },
      onDismiss: hideModal,
    });

    return false;
  };

  return <Prompt when={true} message={onHistoryBlock} />;
});

DashboardPrompt.displayName = 'DashboardPrompt';

function moveToBlockedLocationAfterReactStateUpdate(
  location?: H.Location | null,
  replace = false,
  shouldNavigate: () => boolean = () => true
) {
  if (location) {
    setTimeout(() => {
      if (shouldNavigate()) {
        replace ? locationService.replace(location) : locationService.push(location);
      }
    }, 10);
  }
}

interface UnsavedChangesModalProps {
  onDiscard: () => void;
  onDismiss: () => void;
  onSaveDashboardClick?: () => void;
}

export const UnsavedChangesModal = ({ onDiscard, onDismiss, onSaveDashboardClick }: UnsavedChangesModalProps) => {
  const styles = useStyles2(getStyles);

  return (
    <Modal
      isOpen={true}
      title={t('dashboard-scene.unsaved-changes-modal.title-unsaved-changes', 'Unsaved changes')}
      onDismiss={onDismiss}
      icon="exclamation-triangle"
      className={styles.modal}
    >
      <h5>
        <Trans i18nKey="dashboard-scene.unsaved-changes-modal.changes">Do you want to save your changes?</Trans>
      </h5>
      <Modal.ButtonRow>
        <Button variant="secondary" onClick={onDismiss} fill="outline">
          <Trans i18nKey="dashboard-scene.unsaved-changes-modal.cancel">Cancel</Trans>
        </Button>
        <Button variant="destructive" onClick={onDiscard}>
          <Trans i18nKey="dashboard-scene.unsaved-changes-modal.discard">Discard</Trans>
        </Button>
        <Button onClick={onSaveDashboardClick}>
          <Trans i18nKey="dashboard-scene.unsaved-changes-modal.save-dashboard">Save dashboard</Trans>
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
};

const getStyles = () => ({
  modal: css({
    width: '500px',
  }),
});

/**
 * For some dashboards and users changes should be ignored *
 */
export function ignoreChanges(scene: DashboardScene | null) {
  const original = scene?.getInitialSaveModel();

  if (!original) {
    return true;
  }

  // Ignore changes if original is unsaved
  if (scene?.state.meta.version === 0) {
    return true;
  }

  // Ignore changes if the user has been signed out
  if (!contextSrv.isSignedIn) {
    return true;
  }

  if (!scene) {
    return true;
  }

  const dashboard = scene.getSaveModel();
  // Ignore changes if the dashboard is empty (new dashboard)
  if (isEmptyDashboard(dashboard, scene?.serializer.metadata)) {
    return true;
  }

  const { canSave, fromScript, fromFile } = scene.state.meta;
  if (!contextSrv.isEditor && !canSave) {
    return true;
  }

  return !canSave || fromScript || fromFile || (scene.state.isEditing && !hasActualSaveChanges(scene));
}

export function isEmptyDashboard(
  dashboard: Dashboard | DashboardV2Spec,
  metadata?: DashboardMeta | ObjectMeta
): boolean {
  if (isDashboardV2Spec(dashboard)) {
    const hasNoPanels = Object.keys(dashboard.elements).length === 0;
    const hasNoLinks = !dashboard.links.length;
    const hasNoTemplates = !dashboard.variables.length;
    const hasNoUid = !metadata || !('name' in metadata) || !metadata.name;

    return hasNoPanels && hasNoLinks && hasNoTemplates && hasNoUid;
  }

  const hasNoPanels = !dashboard.panels?.length;
  const hasNoLinks = !dashboard.links?.length;
  const hasNoTemplates = !dashboard.templating?.list?.length;
  const hasNoUid = !dashboard.uid;

  return hasNoPanels && hasNoLinks && hasNoTemplates && hasNoUid;
}
