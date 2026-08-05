"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Box, LinearProgress, Skeleton, Stack } from "@mui/material";
import { useAuth } from "@/contexts/AuthContext";
import { PostureProvider, usePosture } from "@/contexts/PostureContext";
import { colors, gradients, layout } from "@/theme/tokens";
import { StatGridSkeleton } from "@/components/ui/Skeletons";
import Header from "./Header";
import Sidebar from "./Sidebar";

/**
 * Auth gate + chrome. Any route rendered inside this shell requires a session;
 * an unauthenticated visitor is redirected to /login rather than shown an empty
 * dashboard.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isLoading, isAuthenticated, router]);

  // The one place a whole-page skeleton is honest: until the session resolves we
  // do not know the role, so we cannot draw the correct navigation. Sketching
  // the chrome keeps the first paint in the right shape instead of flashing a
  // centred spinner and then snapping into a full layout.
  if (isLoading || !isAuthenticated) {
    return (
      <Box sx={{ display: "flex", minHeight: "100vh", backgroundColor: colors.void }}>
        <Box
          sx={{
            width: layout.railCollapsed,
            flexShrink: 0,
            borderRight: `1px solid ${colors.edge}`,
            backgroundImage: gradients.chrome,
            p: 1.15,
          }}
        >
          <Stack gap={1.6} alignItems="center">
            <Skeleton variant="circular" width={24} height={24} sx={{ mt: 0.6 }} />
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} variant="rounded" width={20} height={20} sx={{ borderRadius: "5px" }} />
            ))}
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Stack
            direction="row"
            alignItems="center"
            gap={2}
            sx={{
              height: layout.headerHeight,
              px: `${layout.gutter}px`,
              borderBottom: `1px solid ${colors.edge}`,
              backgroundImage: gradients.chrome,
            }}
          >
            <Skeleton variant="rounded" width={280} height={26} sx={{ borderRadius: "7px" }} />
            <Skeleton variant="text" width={120} height={12} sx={{ ml: "auto" }} />
            <Skeleton variant="rounded" width={150} height={26} sx={{ borderRadius: "7px" }} />
          </Stack>

          <Box sx={{ flex: 1, px: `${layout.gutter}px`, py: `${layout.gutter - 4}px` }}>
            <Skeleton variant="text" width={240} height={26} />
            <Skeleton variant="text" width={420} height={13} sx={{ mb: 2.4 }} />
            <StatGridSkeleton cards={4} />
          </Box>
        </Box>
      </Box>
    );
  }

  // Everything below the gate shares one live posture read, so the rail, the
  // switcher, global search and the page can never disagree with each other.
  return (
    <PostureProvider>
      <Chrome>{children}</Chrome>
    </PostureProvider>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  const { openCriticalCount, isRefreshing } = usePosture();

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar badges={{ openCritical: openCriticalCount }} />
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Header />

        {/* Background refresh runs in ~1.5s and used to signal itself only by
          * relabelling one small button, which nobody notices. A bar under the
          * header is the standard tell. The page keeps its current data rather
          * than collapsing to a skeleton — the old numbers are still true, and
          * blanking them would be a worse lie than showing them a second stale.
          * Reserving the 2px whether or not it is running keeps the content
          * from jumping each time it fires. */}
        <Box
          aria-hidden={!isRefreshing}
          sx={{
            height: 2,
            flexShrink: 0,
            position: "sticky",
            top: `${layout.headerHeight}px`,
            zIndex: 14,
            overflow: "hidden",
          }}
        >
          {isRefreshing && (
            <LinearProgress
              sx={{
                height: 2,
                backgroundColor: "transparent",
                "& .MuiLinearProgress-bar": { backgroundColor: colors.ion },
              }}
            />
          )}
        </Box>
        <Box
          component="main"
          sx={{
            flex: 1,
            px: `${layout.gutter}px`,
            py: `${layout.gutter - 4}px`,
            minWidth: 0,
            // Faint dot grid — the texture that makes it read "operations
            // console". Kept well below the panel fills so it reads as paper
            // grain rather than as content.
            backgroundImage:
              "radial-gradient(circle, rgba(140,180,255,0.075) 1px, transparent 1px)",
            backgroundSize: "34px 34px",
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}

export default AppShell;
