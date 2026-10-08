import { chunk } from 'lodash';
import { useState } from 'react';
import { useAsync, useMountedState } from 'react-use';

import { Trans, t } from '@grafana/i18n';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, Modal, Text, Space, Box } from '@grafana/ui';
import { useGetFolderQueryFacade } from 'app/api/clients/folder/v1beta1/hooks';
import { ScopedResourceClient } from 'app/features/apiserver/client';
import { AnnoKeyFolder, ObjectMeta } from 'app/features/apiserver/types';
import { K8S_V1_DASHBOARD_API_CONFIG } from 'app/features/dashboard/api/v1';
import { MoveActionAvailableTargetWarning } from 'app/features/provisioning/components/Shared/MoveActionAvailableTargetWarning';
import { ProvisioningAwareFolderPicker } from 'app/features/provisioning/components/Shared/ProvisioningAwareFolderPicker';
import { GENERAL_FOLDER_UID } from 'app/features/search/constants';

import { DashboardTreeSelection } from '../../types';

import { DescendantCount } from './DescendantCount';

export interface Props {
  isOpen: boolean;
  onConfirm: (targetFolderUid: string) => Promise<void>;
  onDismiss: () => void;
  selectedItems: DashboardTreeSelection;
}

export const MoveModal = ({ onConfirm, onDismiss, selectedItems, ...props }: Props) => {
  const [moveTarget, setMoveTarget] = useState<string>();
  const [isMoving, setIsMoving] = useState(false);
  const selectedFolders = Object.keys(selectedItems.folder || {}).filter((uid) => selectedItems.folder[uid]);
  const selectedDashboards = Object.keys(selectedItems.dashboard || {}).filter((uid) => selectedItems.dashboard[uid]);
  const selectedPanels = Object.keys(selectedItems.panel || {}).filter((uid) => selectedItems.panel[uid]);
  const { data: folderData } = useGetFolderQueryFacade(selectedFolders.length === 1 ? selectedFolders[0] : undefined);

  const isMounted = useMountedState();
  const {
    value: canMoveToRoot,
    loading: isCheckingFolders,
    error: folderCheckError,
  } = useAsync(async (): Promise<boolean> => {
    // Selections can outlive search results, so read each dashboard's saved folder.
    const dashboardUids = Object.keys(selectedItems.dashboard).filter((uid) => selectedItems.dashboard[uid]);
    const client = new ScopedResourceClient(K8S_V1_DASHBOARD_API_CONFIG);
    for (const batch of chunk(dashboardUids, 5)) {
      if (!isMounted()) {
        return false;
      }
      const dashboards = await Promise.all(
        batch.map((uid) =>
          getBackendSrv().get<{ metadata: ObjectMeta }>(`${client.url}/${uid}`, undefined, undefined, {
            headers: { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' },
          })
        )
      );
      if (
        dashboards.some((dashboard) => {
          const folderUid = dashboard.metadata.annotations?.[AnnoKeyFolder];
          return folderUid && folderUid !== GENERAL_FOLDER_UID;
        })
      ) {
        return false;
      }
    }
    return true;
  }, [selectedItems.dashboard, isMounted]);
  const showRootFolder = selectedDashboards.length === 0 || (!isCheckingFolders && canMoveToRoot === true);

  // If we are only moving one folder, we can show a different message
  // (we might be in the "Folder actions" version of the modal)
  const onlyOneFolderSelected =
    selectedFolders.length === 1 && selectedDashboards.length === 0 && selectedPanels.length === 0;

  const onMove = async () => {
    if (moveTarget !== undefined) {
      setIsMoving(true);
      try {
        await onConfirm(moveTarget);
        setIsMoving(false);
        onDismiss();
      } catch {
        setIsMoving(false);
      }
    }
  };

  return (
    <Modal title={t('browse-dashboards.action.move-modal-title', 'Move')} onDismiss={onDismiss} {...props}>
      {selectedFolders.length > 0 && (
        <Alert
          severity="info"
          title={t('browse-dashboards.action.move-modal-alert', 'Moving this item may change its permissions.')}
        />
      )}

      <MoveActionAvailableTargetWarning />

      {folderCheckError && (
        <Alert
          severity="warning"
          title={t('browse-dashboards.action.move-modal-folder-check-error', 'Could not check dashboard folders')}
        >
          <Trans i18nKey="browse-dashboards.action.move-modal-folder-check-retry">
            You can still select a named folder. Close and reopen this dialog to try again.
          </Trans>
        </Alert>
      )}

      <Box paddingTop={2}>
        <Text element="p">
          {onlyOneFolderSelected ? (
            <Trans
              i18nKey="browse-dashboards.action.move-modal-text-one-folder"
              values={{ folderName: folderData?.title }}
            >
              This action will move the folder &quot;
              <Text variant="code" weight="bold">
                {'{{ folderName }}'}
              </Text>
              &quot; and the following content:
            </Trans>
          ) : (
            <Trans i18nKey="browse-dashboards.action.move-modal-text">
              This action will move the following content:
            </Trans>
          )}
        </Text>
        <DescendantCount selectedItems={selectedItems} />
      </Box>

      <Space v={3} />

      <Field
        noMargin
        label={t('browse-dashboards.action.move-modal-field-label', 'Folder name')}
        aria-busy={isCheckingFolders}
      >
        <ProvisioningAwareFolderPicker
          value={moveTarget}
          showRootFolder={showRootFolder}
          excludeUIDs={selectedFolders}
          onChange={setMoveTarget}
          repositoryName={undefined} // is non-provisioned folder
        />
      </Field>

      <Modal.ButtonRow>
        <Button onClick={onDismiss} variant="secondary" fill="outline">
          <Trans i18nKey="browse-dashboards.action.cancel-button">Cancel</Trans>
        </Button>
        <Button disabled={moveTarget === undefined || isMoving} onClick={onMove} variant="primary">
          {isMoving
            ? t('browse-dashboards.action.moving', 'Moving...')
            : t('browse-dashboards.action.move-button', 'Move')}
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
};
