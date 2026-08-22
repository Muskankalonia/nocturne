"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { Box, Button, Stack, Typography, alpha } from "@mui/material";
import { useAuth } from "@/contexts/AuthContext";
import { colors, gradients, layout } from "@/theme/tokens";

/**
 * The public front door's only interactive chrome.
 *
 * Split out of the page so everything else can stay a server component: the
 * marketing copy is static and should paint without waiting on JavaScript, and
 * only this bar needs to know whether anyone is signed in.
 *
 * The call to action is auth-aware rather than a fixed "Sign in". Someone who
 * already has a session and lands here from a bookmark should be one click from
 * the console, not asked to authenticate again — the same thing every product
 * site does with its top-right button.
 */

const SECTIONS = [
  { href: "#cascade", label: "How it works" },
  { href: "#platform", label: "Platform"},
  { href: "#evidence", label: "Evidence" },
  { href: "#graph", label: "Knowledge graph" },
] as const;

export function LandingNav() {
  // Transparent over the hero, and a defined bar once the page moves under it.
  // A permanently filled bar reads as chrome and competes with the headline;
  // one that never fills leaves the links floating over content further down.
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const { isAuthenticated } = useAuth();

  return (
    <Box
      component="header"
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        borderBottom: `1px solid ${scrolled ? colors.edge : "transparent"}`,
        backgroundImage: scrolled ? gradients.chrome : "none",
        backdropFilter: scrolled ? "blur(20px)" : "none",
        transition: "border-color 160ms ease, background-image 160ms ease",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        gap={{ xs: 1.5, md: 3 }}
        sx={{
          maxWidth: 1480,
          mx: "auto",
          px: { xs: 2.5, md: 5 },
          height: { xs: 60, md: 68 },
        }}
      >
        <Stack
          component={NextLink}
          href="/"
          direction="row"
          alignItems="center"
          gap={1.2}
          sx={{ textDecoration: "none", color: colors.text1, flexShrink: 0 }}
        >
          {/* 24/17 in the nav rail, 40/28 on the login poster — both ~1.43, so
            * holding that ratio here keeps this reading as the same mark at a
            * third scale rather than as a third logo. */}
          <Box
            component="img"
            src="/nocturne-mark.png"
            alt=""
            width={26}
            height={26}
            sx={{
              display: "block",
              filter: `drop-shadow(0 0 12px ${alpha(colors.ion, 0.45)})`,
            }}
          />
          <Typography
            sx={{ fontWeight: 700, fontSize: 18, letterSpacing: "0.06em", lineHeight: 1 }}
          >
            NOCTURNE
          </Typography>
        </Stack>

        <Stack
          component="nav"
          direction="row"
          gap={2.6}
          sx={{ ml: 2, display: { xs: "none", md: "flex" } }}
        >
          {SECTIONS.map((section) => (
            <Typography
              key={section.href}
              component="a"
              href={section.href}
              sx={{
                fontSize: 13,
                color: colors.text2,
                textDecoration: "none",
                "&:hover": { color: colors.text1 },
              }}
            >
              {section.label}
            </Typography>
          ))}
        </Stack>

        <Button
          component={NextLink}
          href={isAuthenticated ? "/command-center" : "/login"}
          variant="contained"
          sx={{ ml: "auto", px: 2.2, py: 0.9, borderRadius: `${layout.radiusSm}px`, flexShrink: 0 }}
        >
          {isAuthenticated ? "Open console" : "Sign in"}
        </Button>
      </Stack>
    </Box>
  );
}

/**
 * Shown under the hero copy. Same destinations as the landing bar, at the size a
 * primary action wants to be.
 *
 * `secondary` is off at the bottom of the page: the second button scrolls up to
 * #cascade, which is a useful offer beside the headline and a strange one after
 * the reader has already passed it.
 */
export function HeroActions({
  secondary = true,
  align = "flex-start",
}: {
  secondary?: boolean;
  align?: "flex-start" | "center";
}) {
  const { isAuthenticated } = useAuth();

  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      gap={1.4}
      sx={{
        mt: 4,
        alignSelf: align,
        // Stacked on a phone, these are the page's only actions and should fill
        // the measure. `center` would be inherited from the column direction and
        // leave two differently-sized buttons floating mid-screen.
        alignItems: { xs: "stretch", sm: "center" },
      }}
    >
      <Button
        component={NextLink}
        href={isAuthenticated ? "/command-center" : "/login"}
        variant="contained"
        size="large"
        sx={{ px: 3, py: 1.4, fontSize: 13.5 }}
      >
        {isAuthenticated ? "Open console" : "Sign in to the console"}
      </Button>
      {secondary && (
        <Button
          component="a"
          href="#cascade"
          variant="outlined"
          size="large"
          sx={{
            px: 3,
            py: 1.4,
            fontSize: 13.5,
            color: colors.text1,
            borderColor: colors.edgeHi,
            "&:hover": { borderColor: colors.ion, backgroundColor: alpha(colors.ion, 0.06) },
          }}
        >
          See how it works
        </Button>
      )}
    </Stack>
  );
}
