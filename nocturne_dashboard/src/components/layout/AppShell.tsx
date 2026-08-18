"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Box, LinearProgress, Skeleton, Stack, alpha } from "@mui/material";
import { useAuth } from "@/contexts/AuthContext";
import { PostureProvider, usePosture } from "@/contexts/PostureContext";
import { colors, gradients, layout } from "@/theme/tokens";
import { StatGridSkeleton } from "@/components/ui/Skeletons";
import { AssistantDrawer, UmbraFab } from "@/components/assistant/AssistantDrawer";
import Header from "./Header";
import Sidebar from "./Sidebar";

/**
 * Auth gate + chrome. Any route rendered inside this shell requires a session;
 * an unauthenticated visitor is sent to the public landing page rather than
 * shown an empty dashboard.
 *
 * The destination is /start, not /login. Someone arriving with no session is
 * usually arriving for the first time, and a bare credential prompt is a poor
 * thing to open with — the landing page explains what this is and carries a
 * Sign in button for the people who already know.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading, hadSessionHint } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/start");
  }, [isLoading, isAuthenticated, router]);

  // A signed-out visitor is on their way off this route, so drawing dashboard
  // chrome for them is a lie that resolves into a redirect. Two cases are not
  // the same thing and must not share a placeholder:
  //
  //   - resolved and signed out, or no prior session on this device: the next
  //     screen is /start, so show a neutral splash rather than sketching chrome
  //     that is about to be replaced by a completely different page;
  //   - still resolving with a prior session here: the next screen is the
  //     dashboard, so sketching the chrome keeps the first paint in shape.
  if (!isLoading && !isAuthenticated) return <HandoffSplash />;
  if (isLoading && !hadSessionHint) return <HandoffSplash />;

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
  const [assistantOpen, setAssistantOpen] = useState(false);

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

      {/* Umbra AI — floating button + drawer, outside header to avoid backdropFilter containing block */}
      <UmbraFab onClick={() => setAssistantOpen(true)} visible={!assistantOpen} />
      <AssistantDrawer open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </Box>
  );
}

export default AppShell;

/**
 * Held for the moment between "no session" and the landing page rendering.
 *
 * Deliberately not shaped like any particular screen. The old version sketched
 * the two-pane login layout, which worked while /login was the only place a
 * signed-out visitor could go; now that they land on /start instead, a skeleton
 * of the wrong page is worse than no skeleton at all. The mark on the page
 * gradient reads as "loading", commits to nothing, and is correct whichever
 * page comes next.
 */
function HandoffSplash() {
  return (
    <Stack
      justifyContent="center"
      alignItems="center"
      sx={{
        minHeight: "100dvh",
        width: "100%",
        backgroundColor: colors.abyss,
        backgroundImage: gradients.page,
      }}
    >
      <Box
        component="img"
        src="/nocturne-mark.png"
        alt=""
        width={40}
        height={40}
        sx={{
          filter: `drop-shadow(0 0 18px ${alpha(colors.ion, 0.45)})`,
          animation: "nocturnePulse 1.6s ease-in-out infinite",
          "@keyframes nocturnePulse": {
            "0%, 100%": { opacity: 0.45 },
            "50%": { opacity: 1 },
          },
        }}
      />
    </Stack>
  );
}
