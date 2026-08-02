"use client";

import type { ReactNode } from "react";
import { Stack, Typography } from "@mui/material";
import { ShieldOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import { colors } from "@/theme/tokens";

/**
 * Route-level guard for admin pages.
 *
 * This is defence in depth, not the control. Hiding a menu item and refusing to
 * render a page both happen in the browser and can be bypassed. The API route
 * must independently reject a non-admin session — this exists so a mistyped URL
 * shows something sensible rather than a broken page.
 */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { isSuperAdmin, isLoading } = useAuth();

  if (isLoading) return null;

  if (!isSuperAdmin) {
    return (
      <Stack gap={2}>
        <Panel>
          <Stack direction="row" gap={1.6} alignItems="flex-start">
            <ShieldOff size={20} color={colors.critical} style={{ flexShrink: 0, marginTop: 2 }} />
            <Stack gap={0.6}>
              <Typography sx={{ fontSize: 15, fontWeight: 600 }}>
                This page is restricted to fleet administrators
              </Typography>
              <Typography sx={{ fontSize: 12.5, color: colors.text2, lineHeight: 1.7 }}>
                Your session is scoped to a single organization. Fleet-wide pages combine data from
                every tenant, so they are unavailable here — and the API would refuse the request
                even if this page rendered.
              </Typography>
            </Stack>
          </Stack>
        </Panel>
      </Stack>
    );
  }

  return <>{children}</>;
}

export default AdminOnly;
