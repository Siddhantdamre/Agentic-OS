/**
 * @jest-environment node
 *
 * Kept analytics routes must be referenced by a UI module; removed routes must
 * have no remaining imports/fetch callers.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const dashboardRoot = join(__dirname, '../..');
const analyticsPage = join(dashboardRoot, 'app/(dashboard)/analytics/page.tsx');
const calibrationRoute = join(dashboardRoot, 'app/api/analytics/calibration/route.ts');

describe('analytics roi / cost-health / calibration consumers', () => {
  const pageSrc = readFileSync(analyticsPage, 'utf8');

  it('wires /api/analytics/roi from the analytics page', () => {
    expect(pageSrc).toContain("fetch('/api/analytics/roi')");
  });

  it('wires /api/analytics/cost-health from the analytics page', () => {
    expect(pageSrc).toContain("fetch('/api/analytics/cost-health')");
  });

  it('uses observability metrics for calibration (single source)', () => {
    expect(pageSrc).toContain("fetch('/api/observability/metrics')");
    expect(pageSrc).toContain('confidence_calibration_drift');
    expect(pageSrc).not.toContain('/api/analytics/calibration');
  });

  it('removed /api/analytics/calibration route file', () => {
    expect(existsSync(calibrationRoute)).toBe(false);
  });
});
