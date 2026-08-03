"use client";

import { createTheme, alpha } from "@mui/material/styles";
import { colors, fonts, gradients, layout, shadows } from "./tokens";

declare module "@mui/material/styles" {
  interface Palette {
    severity: {
      critical: string;
      high: string;
      medium: string;
      low: string;
      informational: string;
    };
    verified: string;
    surfaceGlass: string;
    edge: string;
    edgeHi: string;
  }
  interface PaletteOptions {
    severity?: Palette["severity"];
    verified?: string;
    surfaceGlass?: string;
    edge?: string;
    edgeHi?: string;
  }
}

/**
 * Single-theme by design. A security operations console is a dark instrument;
 * a light variant would be an omission dressed up as a feature.
 */
export const theme = createTheme({
  cssVariables: true,
  palette: {
    mode: "dark",
    primary: { main: colors.ion, dark: colors.ionDim, contrastText: "#04101F" },
    secondary: { main: colors.verified, contrastText: "#052E14" },
    error: { main: colors.critical },
    warning: { main: colors.high },
    info: { main: colors.low },
    success: { main: colors.verified },
    background: { default: colors.void, paper: colors.hull },
    text: {
      primary: colors.text1,
      secondary: colors.text2,
      disabled: colors.text3,
    },
    divider: colors.edge,
    severity: {
      critical: colors.critical,
      high: colors.high,
      medium: colors.medium,
      low: colors.low,
      informational: colors.informational,
    },
    verified: colors.verified,
    surfaceGlass: colors.glass,
    edge: colors.edge,
    edgeHi: colors.edgeHi,
  },
  shape: { borderRadius: layout.radius },
  typography: {
    fontFamily: fonts.sans,
    // A tight, deliberate scale. Page titles are the largest thing on screen and
    // they are still only 22px — density is the point, not scale.
    h1: { fontSize: 26, fontWeight: 650, letterSpacing: "-0.022em", lineHeight: 1.2 },
    h2: { fontSize: 21, fontWeight: 640, letterSpacing: "-0.019em", lineHeight: 1.25 },
    h3: { fontSize: 17, fontWeight: 620, letterSpacing: "-0.015em", lineHeight: 1.3 },
    h4: { fontSize: 14.5, fontWeight: 620, letterSpacing: "-0.008em", lineHeight: 1.35 },
    body1: { fontSize: 13, lineHeight: 1.6, letterSpacing: "-0.003em" },
    body2: { fontSize: 12, lineHeight: 1.55, letterSpacing: "-0.002em" },
    caption: { fontSize: 11, color: colors.text3, letterSpacing: 0 },
    button: { textTransform: "none", fontWeight: 600, fontSize: 12.5, letterSpacing: "-0.002em" },
    // Uppercase section labels — small, wide tracking, tertiary colour.
    overline: {
      fontFamily: fonts.mono,
      fontSize: 10,
      fontWeight: 500,
      letterSpacing: "0.15em",
      textTransform: "uppercase",
      color: colors.text3,
      lineHeight: 1.6,
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale" },
        body: {
          backgroundColor: colors.abyss,
          backgroundImage: gradients.page,
          backgroundAttachment: "fixed",
          // Tabular figures everywhere digits line up in columns.
          fontVariantNumeric: "tabular-nums",
          // Inter's optical-size + contextual alternates; cheap polish.
          fontFeatureSettings: '"cv05" 1, "cv08" 1, "ss01" 1',
        },
        "*::-webkit-scrollbar": { width: 8, height: 8 },
        "*::-webkit-scrollbar-track": { background: "transparent" },
        "*::-webkit-scrollbar-thumb": {
          background: colors.edgeHi,
          borderRadius: 5,
        },
        "*::-webkit-scrollbar-thumb:hover": { background: alpha(colors.ion, 0.45) },
        "::selection": { background: alpha(colors.ion, 0.3) },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundColor: colors.glass,
          backgroundImage: gradients.panel,
          backdropFilter: "blur(20px)",
          border: `1px solid ${colors.edge}`,
          boxShadow: shadows.panel,
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: layout.radiusSm,
          paddingInline: 14,
          minHeight: 34,
        },
        sizeSmall: { minHeight: 28, paddingInline: 10, fontSize: 11.5 },
        containedPrimary: {
          background: gradients.action,
          boxShadow: `0 1px 0 ${alpha("#FFFFFF", 0.14)} inset, 0 8px 22px -12px ${alpha(colors.ion, 0.9)}`,
          color: "#FFFFFF",
          "&:hover": {
            background: `linear-gradient(180deg, ${colors.ionBright} 0%, ${colors.ion} 100%)`,
          },
        },
        outlined: {
          borderColor: colors.edgeHi,
          "&:hover": {
            borderColor: alpha(colors.ion, 0.5),
            backgroundColor: alpha(colors.ion, 0.07),
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontFamily: fonts.mono,
          fontSize: 10,
          fontWeight: 500,
          height: 20,
          borderRadius: 4,
        },
        label: { paddingInline: 7 },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: colors.hullHi,
          border: `1px solid ${colors.edgeHi}`,
          boxShadow: shadows.menu,
          fontSize: 11.5,
          fontFamily: fonts.sans,
          padding: "6px 9px",
          borderRadius: layout.radiusSm,
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: alpha(colors.abyss, 0.7),
          fontFamily: fonts.mono,
          fontSize: 12.5,
          borderRadius: layout.radiusSm,
          "& fieldset": { borderColor: colors.edge },
          "&:hover fieldset": { borderColor: colors.edgeHi },
          "&.Mui-focused fieldset": {
            borderColor: alpha(colors.ion, 0.6),
            borderWidth: 1,
          },
          "&.Mui-focused": {
            boxShadow: `0 0 0 3px ${alpha(colors.ion, 0.14)}`,
          },
        },
        input: { paddingBlock: 9 },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontFamily: fonts.mono,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.13em",
          textTransform: "uppercase",
          color: colors.text3,
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundImage: gradients.chrome,
          border: `1px solid ${colors.edgeHi}`,
          boxShadow: shadows.menu,
        },
      },
    },
    MuiDivider: { styleOverrides: { root: { borderColor: colors.edge } } },
    // MUI's default skeleton is a light grey built for a white page and glows
    // like a light bulb on this ground. Themed once here so every skeleton in
    // the app reads as "a panel that has not filled in yet".
    MuiSkeleton: {
      defaultProps: { animation: "wave" },
      styleOverrides: {
        root: {
          backgroundColor: "rgba(104,146,224,0.09)",
          "&::after": {
            background: `linear-gradient(90deg, transparent, ${alpha(colors.ion, 0.10)}, transparent)`,
          },
          "@media (prefers-reduced-motion: reduce)": {
            "&::after": { animation: "none" },
          },
        },
      },
    },
    // Keyboard focus must always be visible.
    MuiButtonBase: {
      styleOverrides: {
        root: {
          "&.Mui-focusVisible": {
            outline: `2px solid ${alpha(colors.ion, 0.7)}`,
            outlineOffset: 2,
          },
        },
      },
    },
  },
});

export default theme;
