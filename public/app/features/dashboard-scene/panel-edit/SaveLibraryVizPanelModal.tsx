import { useCallback, useRef, useState } from 'react';
import { useAsync, useDebounce } from 'react-use';

import { Trans, t } from '@grafana/i18n';
import { Button, Icon, Input, Modal, useStyles2 } from '@grafana/ui';
import { getConnectedDashboards } from 'app/features/library-panels/state/api';
import { getModalStyles } from 'app/features/library-panels/styles';

import { LibraryPanelBehavior } from '../scene/LibraryPanelBehavior';

interface Props {
  libraryPanel: LibraryPanelBehavior;
  isUnsavedPrompt?: boolean;
  isSaving?: boolean;
  onConfirm: () => void | Promise<unknown>;
  onDismiss: () => void;
  onDiscard: () => void;
}

export const SaveLibraryVizPanelModal = ({
  libraryPanel,
  isUnsavedPrompt,
  isSaving = false,
  onDismiss,
  onConfirm,
  onDiscard,
}: Props) => {
  const [searchString, setSearchString] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const savingRef = useRef(false);
  const dashState = useAsync(async () => {
    const searchHits = await getConnectedDashboards(libraryPanel.state.uid);
    if (searchHits && searchHits.length > 0) {
      return searchHits.map((dash) => dash.name);
    }

    return [];
  }, [libraryPanel.state.uid]);

  const [filteredDashboards, setFilteredDashboards] = useState<string[]>([]);
  useDebounce(
    () => {
      if (!dashState.value) {
        return setFilteredDashboards([]);
      }

      return setFilteredDashboards(
        dashState.value.filter((dashName) => dashName.toLowerCase().includes(searchString.toLowerCase()))
      );
    },
    300,
    [dashState.value, searchString]
  );

  const styles = useStyles2(getModalStyles);
  const saving = isSaving || isSubmitting;
  const handleDiscard = useCallback(() => {
    if (!savingRef.current && !isSaving) {
      onDiscard();
    }
  }, [isSaving, onDiscard]);
  const handleConfirm = useCallback(async () => {
    if (savingRef.current || isSaving) {
      return;
    }

    savingRef.current = true;
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      savingRef.current = false;
      setIsSubmitting(false);
    }
  }, [isSaving, onConfirm]);
  const handleDismiss = useCallback(() => {
    if (!savingRef.current && !isSaving) {
      onDismiss();
    }
  }, [isSaving, onDismiss]);

  const title = isUnsavedPrompt ? 'Unsaved library panel changes' : 'Save library panel';

  return (
    <Modal title={title} onDismiss={handleDismiss} isOpen={true}>
      <div>
        <p className={styles.textInfo}>
          <Trans
            i18nKey="dashboard-scene.save-library-viz-panel-modal.affected-dashboards"
            count={libraryPanel.state._loadedPanel?.meta?.connectedDashboards}
          >
            This update will affect <strong>{'{{count}}'} dashboards.</strong> The following dashboards using the panel
            will be affected:
          </Trans>
        </p>
        <Input
          className={styles.dashboardSearch}
          prefix={<Icon name="search" />}
          placeholder={t(
            'dashboard-scene.save-library-viz-panel-modal.placeholder-search-affected-dashboards',
            'Search affected dashboards'
          )}
          value={searchString}
          onChange={(e) => setSearchString(e.currentTarget.value)}
        />
        {dashState.loading ? (
          <p>
            <Trans i18nKey="dashboard-scene.save-library-viz-panel-modal.loading-connected-dashboards">
              Loading connected dashboards...
            </Trans>
          </p>
        ) : (
          <table className={styles.myTable}>
            <thead>
              <tr>
                <th>
                  <Trans i18nKey="dashboard-scene.save-library-viz-panel-modal.dashboard-name">Dashboard name</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredDashboards.map((dashName, i) => (
                <tr key={`dashrow-${i}`}>
                  <td>{dashName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Modal.ButtonRow>
          <Button variant="secondary" onClick={handleDismiss} fill="outline" disabled={saving}>
            <Trans i18nKey="dashboard-scene.save-library-viz-panel-modal.cancel">Cancel</Trans>
          </Button>
          {isUnsavedPrompt && (
            <Button variant="destructive" onClick={handleDiscard} disabled={saving}>
              <Trans i18nKey="dashboard-scene.save-library-viz-panel-modal.discard">Discard</Trans>
            </Button>
          )}
          <Button onClick={handleConfirm} disabled={saving}>
            <Trans i18nKey="dashboard-scene.save-library-viz-panel-modal.update-all">Update all</Trans>
          </Button>
        </Modal.ButtonRow>
      </div>
    </Modal>
  );
};
