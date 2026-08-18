import { DashboardCursorSync } from '@grafana/data';
import { config } from '@grafana/runtime';

export function getEffectiveCursorSync(sync?: DashboardCursorSync) {
  return sync || (config.bootData.user.sharedCrosshair ? DashboardCursorSync.Crosshair : DashboardCursorSync.Off);
}
