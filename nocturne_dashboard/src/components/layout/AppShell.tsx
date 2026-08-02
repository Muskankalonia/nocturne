"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Box, CircularProgress, Stack } from "@mui/material";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { incidents } from "@/mocks/incidents";
import { colors } from "@/theme/tokens";
import Header from "./Header";
import Sidebar from "./Sidebar";

/**
 * Auth gate + chrome. Any route rendered inside this shell requires a session;
 * an unauthenticated visitor is redirected to /login rather than shown an empty
 * dashboard.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading, session, isFleetScope } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isLoading, isAuthenticated, router]);

  const badges = useMemo(() => {
    if (!session) return {};
    const orgId = scopeOrgId(session.scope);
    const scoped = orgId === null ? incidents : incidents.filter((i) => i.orgId === orgId);
    return {
      openCritical: scoped.filter(
        (i) =>
          i.impactSeverityBand === "critical" &&
          i.remediationStatus !== "resolved" &&
          i.remediationStatus !== "false_positive",
      ).length,
    };
  }, [session, isFleetScope]);

  if (isLoading || !isAuthenticated) {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ minHeight: "100vh", backgroundColor: colors.void }}
      >
        <CircularProgress size={26} sx={{ color: colors.ion }} />
      </Stack>
    );
  }

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", backgroundColor: colors.void }}>
      <Sidebar badges={badges} />
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Header />
        <Box
          component="main"
          sx={{
            flex: 1,
            p: 2.4,
            minWidth: 0,
            // Faint dot grid — the texture that makes it read "operations console".
            backgroundImage:
              "radial-gradient(circle, rgba(140,180,255,0.13) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}

export default AppShell;
