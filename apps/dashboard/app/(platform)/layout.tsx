import { AppShell } from '@/components/shell/AppShell';

/**
 * Platform console shares the product shell (cream/amber theme, nav, banners)
 * so operators stay in the same visual system as the rest of the dashboard.
 */
export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
