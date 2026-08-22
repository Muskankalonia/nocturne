import { Box } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { colors } from "@/theme/tokens";

/**
 * Moving backdrop for the landing-page hero.
 *
 * Pure CSS on three absolutely positioned layers — no canvas, no animation
 * library, no client component. Everything here is `transform` and `opacity`,
 * which the compositor handles off the main thread, so it costs nothing on a
 * page whose job is to load fast.
 *
 * Restraint is the brief. This sits behind a security product's headline, and
 * anything that reads as a screensaver undoes the seriousness the rest of the
 * design is buying. The two glows move slowly enough that you notice the page
 * is alive without being able to watch it happen, and the grid drifts about one
 * cell a minute.
 *
 * Motion is dropped entirely under `prefers-reduced-motion`. The layers stay —
 * they still look composed at rest — they just stop moving.
 */
export function AmbientBackdrop() {
  return (
    <Box
      aria-hidden
      sx={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
        "@media (prefers-reduced-motion: reduce)": {
          "& *": { animation: "none !important" },
        },
      }}
    >
      {/* Drifting dot grid — the same texture the console uses for its main
        * surface, so the landing page reads as the same instrument. */}
      <Box
        sx={{
          position: "absolute",
          // Oversized so the translation never exposes an edge.
          inset: "-60px",
          backgroundImage: `radial-gradient(circle, ${alpha(colors.ion, 0.11)} 1px, transparent 1px)`,
          backgroundSize: "38px 38px",
          maskImage: "radial-gradient(1100px 700px at 30% 30%, #000 20%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(1100px 700px at 30% 30%, #000 20%, transparent 78%)",
          animation: "nocturneGridDrift 60s linear infinite",
          "@keyframes nocturneGridDrift": {
            from: { transform: "translate3d(0, 0, 0)" },
            to: { transform: "translate3d(38px, 38px, 0)" },
          },
        }}
      />

      {/* Cool glow, upper left — anchored near the headline. */}
      <Glow
        color={alpha(colors.ion, 0.2)}
        size={980}
        left="-14%"
        top="-30%"
        animation="nocturneDriftA 34s ease-in-out infinite"
        keyframes={{
          "@keyframes nocturneDriftA": {
            "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
            "50%": { transform: "translate3d(90px, 60px, 0) scale(1.12)" },
          },
        }}
      />

      {/* Warm counterweight, lower right. Critical red at very low alpha — the
        * one hint on the page that the subject matter is breaches, kept far
        * enough below the severity ramp's working range to never be mistaken
        * for a severity signal. */}
      <Glow
        color={alpha(colors.critical, 0.1)}
        size={820}
        right="-12%"
        bottom="-34%"
        animation="nocturneDriftB 42s ease-in-out infinite"
        keyframes={{
          "@keyframes nocturneDriftB": {
            "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1.06)" },
            "50%": { transform: "translate3d(-70px, -50px, 0) scale(0.94)" },
          },
        }}
      />
    </Box>
  );
}

function Glow({
  color,
  size,
  animation,
  keyframes,
  ...position
}: {
  color: string;
  size: number;
  animation: string;
  keyframes: Record<string, unknown>;
  left?: string;
  right?: string;
  top?: string;
  bottom?: string;
}) {
  return (
    <Box
      sx={{
        position: "absolute",
        width: size,
        height: size * 0.78,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${color}, transparent 66%)`,
        filter: "blur(30px)",
        willChange: "transform",
        animation,
        ...keyframes,
        ...position,
      }}
    />
  );
}

export default AmbientBackdrop;
