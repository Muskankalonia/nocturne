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
  const { isAuthenticated, isLoading, hadSessionHint } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isLoading, isAuthenticated, router]);

  // A signed-out visitor is on their way to /login, so drawing dashboard chrome
  // for them is a lie that resolves into a redirect. Two cases are not the same
  // thing and must not share a placeholder:
  //
  //   - resolved and signed out, or no prior session on this device: the next
  //     screen is /login, so sketch that instead;
  //   - still resolving with a prior session here: the next screen is the
  //     dashboard, so sketching the chrome keeps the first paint in shape.
  if (!isLoading && !isAuthenticated) return <LoginSkeleton />;
  if (isLoading && !hadSessionHint) return <LoginSkeleton />;

  if (isLoading) {
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

/**
 * Placeholder in the shape of /login, for visitors who are on their way there.
 * Deliberately structural — two panes and a card outline — so it reads as the
 * same page arriving rather than as different content being replaced.
 */
function LoginSkeleton() {
  return (
    <Stack
      direction={{ xs: "column", md: "row" }}
      sx={{ minHeight: "100dvh", width: "100%", backgroundColor: colors.void }}
    >
      <Stack
        sx={{
          flex: { md: 1.15 },
          p: { xs: 3.5, sm: 5, md: 7, lg: 10 },
          borderRight: { md: `1px solid ${colors.edge}` },
          borderBottom: { xs: `1px solid ${colors.edge}`, md: "none" },
        }}
      >
        <Stack direction="row" alignItems="center" gap={1.8}>
          <Skeleton variant="rounded" width={40} height={40} sx={{ borderRadius: "10px" }} />
          <Skeleton variant="text" width={150} height={28} />
        </Stack>
        <Stack gap={1.2} sx={{ mt: "auto" }}>
          <Skeleton variant="text" width="60%" height={40} />
          <Skeleton variant="text" width="80%" height={14} />
          <Skeleton variant="text" width="70%" height={14} />
        </Stack>
      </Stack>

      <Stack
        justifyContent="center"
        alignItems="center"
        sx={{ flex: { md: 1 }, p: { xs: 3, sm: 4, md: 6 } }}
      >
        <Box
          sx={{
            width: "100%",
            maxWidth: 400,
            p: { xs: 2.5, sm: 3.5 },
            borderRadius: `${layout.radius}px`,
            border: `1px solid ${colors.edge}`,
            backgroundImage: gradients.panel,
          }}
        >
          <Stack gap={2}>
            <Skeleton variant="text" width={120} height={22} />
            <Skeleton variant="rounded" height={40} sx={{ borderRadius: "8px" }} />
            <Skeleton variant="rounded" height={40} sx={{ borderRadius: "8px" }} />
            <Skeleton variant="rounded" height={38} sx={{ borderRadius: "8px" }} />
          </Stack>
        </Box>
      </Stack>
    </Stack>
  );
}
