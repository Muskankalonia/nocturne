"use client";

import { createTheme, alpha } from "@mui/material/styles";
import { colors, fonts, layout } from "./tokens";

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
    primary: { main: colors.ion, dark: colors.ionDim, contrastText: "#04222B" },
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
    h1: { fontSize: 30, fontWeight: 600, letterSpacing: "-0.025em" },
    h2: { fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" },
    h3: { fontSize: 19, fontWeight: 600, letterSpacing: "-0.015em" },
    h4: { fontSize: 16, fontWeight: 600 },
    body1: { fontSize: 13.5, lineHeight: 1.65 },
    body2: { fontSize: 12.5, lineHeight: 1.6 },
    caption: { fontSize: 11, color: colors.text3 },
    button: { textTransform: "none", fontWeight: 600, fontSize: 13 },
    // Uppercase section labels — 10.5px, wide tracking, tertiary colour.
    overline: {
      fontFamily: fonts.mono,
      fontSize: 10.5,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: colors.text3,
      lineHeight: 1.6,
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: colors.void,
          backgroundImage: [
            `radial-gradient(1200px 700px at 12% -8%, ${alpha(colors.ion, 0.055)}, transparent 60%)`,
            `radial-gradient(900px 600px at 92% 4%, ${alpha(colors.critical, 0.045)}, transparent 60%)`,
          ].join(","),
          backgroundAttachment: "fixed",
          // Tabular figures everywhere digits line up in columns.
          fontVariantNumeric: "tabular-nums",
        },
        "*::-webkit-scrollbar": { width: 9, height: 9 },
        "*::-webkit-scrollbar-track": { background: "transparent" },
        "*::-webkit-scrollbar-thumb": {
          background: colors.edgeHi,
          borderRadius: 6,
        },
        "*::-webkit-scrollbar-thumb:hover": { background: alpha(colors.ion, 0.4) },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundColor: colors.glass,
          backdropFilter: "blur(18px)",
          border: `1px solid ${colors.edge}`,
          backgroundImage: "none",
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: layout.radiusSm },
        containedPrimary: {
          background: `linear-gradient(180deg, ${colors.ion}, ${colors.ionDim})`,
          boxShadow: `0 0 26px -8px ${alpha(colors.ion, 0.85)}`,
          "&:hover": {
            background: `linear-gradient(180deg, ${colors.ion}, ${colors.ion})`,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontFamily: fonts.mono,
          fontSize: 10,
          height: 22,
          borderRadius: 5,
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: "#0B1322",
          border: `1px solid ${colors.edgeHi}`,
          fontSize: 11.5,
          fontFamily: fonts.sans,
          padding: "7px 10px",
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: "rgba(6,11,20,0.85)",
          fontFamily: fonts.mono,
          fontSize: 13,
          "& fieldset": { borderColor: colors.edge },
          "&:hover fieldset": { borderColor: colors.edgeHi },
          "&.Mui-focused fieldset": {
            borderColor: alpha(colors.ion, 0.55),
            borderWidth: 1,
          },
          "&.Mui-focused": {
            boxShadow: `0 0 0 3px ${alpha(colors.ion, 0.11)}, 0 0 20px -6px ${alpha(colors.ion, 0.6)}`,
          },
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontFamily: fonts.mono,
          fontSize: 11,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: colors.text3,
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
