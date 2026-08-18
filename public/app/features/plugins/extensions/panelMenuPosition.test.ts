import { PanelMenuItem } from '@grafana/data';

import { applyPanelMenuPositions } from './panelMenuPosition';

describe('applyPanelMenuPositions', () => {
  const first: PanelMenuItem = { text: 'View' };
  const second: PanelMenuItem = { text: 'Edit' };
  const action: PanelMenuItem = { text: 'Run analysis', onClick: jest.fn() };
  const another: PanelMenuItem = { text: 'Open report' };

  it('places actions at zero-based positions without inspecting their titles', () => {
    const items = [first, second, action, another];
    expect(
      applyPanelMenuPositions(
        items,
        new Map([
          [action, 0],
          [another, 2],
        ])
      )
    ).toEqual([action, first, another, second]);
    expect(items).toEqual([first, second, action, another]);
  });

  it('preserves existing order for ties and appends out-of-range positions', () => {
    expect(
      applyPanelMenuPositions(
        [first, action, second, another],
        new Map([
          [another, 0],
          [action, 0],
        ])
      )
    ).toEqual([action, another, first, second]);
    expect(
      applyPanelMenuPositions(
        [action, first, another],
        new Map([
          [action, 99],
          [another, 99],
        ])
      )
    ).toEqual([first, action, another]);
  });

  it.each([undefined, -1, 0.5, NaN, Infinity])('ignores invalid or absent position %s', (position) => {
    const items = [first, action];
    expect(applyPanelMenuPositions(items, new Map([[action, position]]))).toBe(items);
  });
});
