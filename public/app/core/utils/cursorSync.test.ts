import { DashboardCursorSync } from '@grafana/data';
import { config } from '@grafana/runtime';

import { getEffectiveCursorSync } from './cursorSync';

describe('getEffectiveCursorSync', () => {
  afterEach(() => {
    config.bootData.user.sharedCrosshair = false;
  });

  it('uses the user preference when dashboard cursor sync is off', () => {
    config.bootData.user.sharedCrosshair = true;

    expect(getEffectiveCursorSync(DashboardCursorSync.Off)).toBe(DashboardCursorSync.Crosshair);
  });

  it('preserves dashboard cursor sync', () => {
    config.bootData.user.sharedCrosshair = true;

    expect(getEffectiveCursorSync(DashboardCursorSync.Tooltip)).toBe(DashboardCursorSync.Tooltip);
  });
});
