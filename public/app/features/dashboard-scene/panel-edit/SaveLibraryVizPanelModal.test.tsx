import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TestProvider } from 'test/helpers/TestProvider';

import { LibraryPanelBehavior } from '../scene/LibraryPanelBehavior';

import { SaveLibraryVizPanelModal } from './SaveLibraryVizPanelModal';

jest.mock('app/features/library-panels/state/api', () => ({
  getConnectedDashboards: jest.fn().mockResolvedValue([]),
}));

describe('SaveLibraryVizPanelModal', () => {
  it('allows only one save and disables dismissal while it is pending', async () => {
    const user = userEvent.setup();
    const libraryPanel = new LibraryPanelBehavior({ name: 'Library panel', uid: 'library-panel' });
    let finishSave!: () => void;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    const onDismiss = jest.fn();
    const onDiscard = jest.fn();

    render(
      <TestProvider>
        <SaveLibraryVizPanelModal
          libraryPanel={libraryPanel}
          isUnsavedPrompt
          onConfirm={onConfirm}
          onDismiss={onDismiss}
          onDiscard={onDiscard}
        />
      </TestProvider>
    );

    const updateButton = screen.getByRole('button', { name: 'Update all' });
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    const discardButton = screen.getByRole('button', { name: 'Discard' });
    await user.click(updateButton);

    expect(updateButton).toBeDisabled();
    expect(cancelButton).toBeDisabled();
    expect(discardButton).toBeDisabled();
    await user.click(updateButton);
    await user.click(cancelButton);
    await user.click(discardButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();

    finishSave();
    await waitFor(() => expect(updateButton).toBeEnabled());
  });
});
