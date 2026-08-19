import { PanelMenuItem } from '@grafana/data';

/** Apply explicit positions after the complete panel menu has been assembled. */
export function applyPanelMenuPositions(
  items: PanelMenuItem[],
  positions: ReadonlyMap<PanelMenuItem, number | undefined>
): PanelMenuItem[] {
  const positioned: Array<{ item: PanelMenuItem; position: number }> = [];
  for (const item of items) {
    const position = positions.get(item);
    if (typeof position === 'number' && Number.isInteger(position) && position >= 0) {
      positioned.push({ item, position });
    }
  }

  if (positioned.length === 0) {
    return items;
  }

  const moving = new Set(positioned.map(({ item }) => item));
  const result = items.filter((item) => !moving.has(item));
  let previousIndex = -1;
  for (const { item, position } of positioned.sort((a, b) => a.position - b.position)) {
    const index = Math.min(result.length, Math.max(position, previousIndex + 1));
    result.splice(index, 0, item);
    previousIndex = index;
  }
  return result;
}
