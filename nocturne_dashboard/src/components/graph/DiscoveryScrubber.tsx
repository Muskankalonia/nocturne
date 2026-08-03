"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, IconButton, Slider, Stack, Typography } from "@mui/material";
import { Pause, Play, SkipBack } from "lucide-react";
import { colors, fonts } from "@/theme/tokens";

/**
 * The time axis for the knowledge graph.
 *
 * Every graph node and edge carries FIRST_SEEN. Sorting the distinct values
 * gives the order in which the crawler and the cascade actually found each
 * piece of the incident, and stepping through them turns "3 sightings" into a
 * sequence an analyst can narrate.
 *
 * Two deliberate choices:
 *
 *   1. The slider snaps to real discovery events rather than sliding through
 *      continuous time. Dead space between stops tells you nothing, and a
 *      discrete step means every drag reveals exactly one new thing.
 *
 *   2. When a component was collected in a single crawl there is no sequence to
 *      replay, so the control disables itself and says so. That is the common
 *      case on a freshly seeded warehouse and it must not look broken.
 */

export interface DiscoveryScrubberProps {
  /** FIRST_SEEN of everything currently on the canvas. Duplicates are fine. */
  timestamps: string[];
  /** Index into the distinct sorted stops. Use `stopCount(timestamps) - 1` for "show all". */
  stopIndex: number;
  onStopIndexChange: (index: number) => void;
  /** Rendered on the right of the readout, e.g. "6 of 8 relationships". */
  revealedLabel?: string;
  /** Milliseconds per step when playing. */
  playIntervalMs?: number;
}

/** Distinct FIRST_SEEN values, oldest first. */
export function discoveryStops(timestamps: string[]): string[] {
  return [...new Set(timestamps.filter(Boolean))].sort();
}

export function stopCount(timestamps: string[]): number {
  return discoveryStops(timestamps).length;
}

/**
 * The cutoff for a given stop index. Anything whose FIRST_SEEN is at or before
 * this instant has been discovered; everything else is still unknown.
 */
export function cutoffForStop(timestamps: string[], stopIndex: number): string | null {
  const stops = discoveryStops(timestamps);
  if (stops.length === 0) return null;
  const clamped = Math.min(Math.max(stopIndex, 0), stops.length - 1);
  return stops[clamped];
}

const UTC = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatStop(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${UTC.format(date).replace(",", "")} UTC`;
}

export function DiscoveryScrubber({
  timestamps,
  stopIndex,
  onStopIndexChange,
  revealedLabel,
  playIntervalMs = 1100,
}: DiscoveryScrubberProps) {
  const stops = useMemo(() => discoveryStops(timestamps), [timestamps]);
  const lastIndex = Math.max(stops.length - 1, 0);
  const hasSequence = stops.length > 1;

  const timerRef = useRef<number | null>(null);
  // The timer lives in a ref, but the button's icon has to re-render when it
  // starts and stops — a ref mutation alone would leave it showing "play"
  // through the entire replay.
  const [isPlaying, setIsPlaying] = useState(false);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

  const play = useCallback(() => {
    if (!hasSequence) return;
    stop();
    // Restart from the beginning when replaying a finished timeline.
    let cursor = stopIndex >= lastIndex ? 0 : stopIndex;
    onStopIndexChange(cursor);
    setIsPlaying(true);
    timerRef.current = window.setInterval(() => {
      cursor += 1;
      onStopIndexChange(cursor);
      if (cursor >= lastIndex) stop();
    }, playIntervalMs);
  }, [hasSequence, lastIndex, onStopIndexChange, playIntervalMs, stop, stopIndex]);

  const marks = useMemo(
    () => stops.map((_, index) => ({ value: index })),
    [stops],
  );

  const label = (
    <Stack direction="row" alignItems="baseline" gap={1.2} sx={{ minWidth: 0 }}>
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 12,
          color: colors.ionBright,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {formatStop(cutoffForStop(timestamps, stopIndex))}
      </Typography>
      {revealedLabel && (
        <Typography
          sx={{
            fontFamily: fonts.mono,
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: colors.text3,
            whiteSpace: "nowrap",
          }}
        >
          {revealedLabel}
        </Typography>
      )}
    </Stack>
  );

  if (!hasSequence) {
    return (
      <Stack
        direction="row"
        alignItems="center"
        gap={1.5}
        flexWrap="wrap"
        sx={{ px: 2, py: 1.25, borderTop: `1px solid ${colors.edge}` }}
      >
        <Typography
          sx={{
            fontFamily: fonts.mono,
            fontSize: 10.5,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: colors.text3,
          }}
        >
          Discovery timeline
        </Typography>
        <Box sx={{ flex: 1, minWidth: 120, height: 3, bgcolor: colors.edge, borderRadius: 2 }} />
        <Typography sx={{ fontSize: 12, color: colors.text3 }}>
          {stops.length === 0
            ? "No discovery timestamps on this component."
            : `Collected in a single window — ${formatStop(stops[0])}. The timeline fills in as the crawler revisits.`}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack
      direction="row"
      alignItems="center"
      gap={1.5}
      flexWrap="wrap"
      sx={{ px: 2, py: 1, borderTop: `1px solid ${colors.edge}` }}
    >
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 10.5,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: colors.text3,
          whiteSpace: "nowrap",
        }}
      >
        Discovery timeline
      </Typography>

      <Stack direction="row" gap={0.25}>
        <IconButton
          size="small"
          aria-label={isPlaying ? "Pause replay" : "Play discovery replay"}
          onClick={() => (isPlaying ? stop() : play())}
          sx={{ color: colors.ion, "&:hover": { bgcolor: "rgba(76,141,255,0.12)" } }}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </IconButton>
        <IconButton
          size="small"
          aria-label="Reset to first discovery"
          onClick={() => {
            stop();
            onStopIndexChange(0);
          }}
          sx={{ color: colors.text3, "&:hover": { bgcolor: "rgba(76,141,255,0.12)" } }}
        >
          <SkipBack size={14} />
        </IconButton>
      </Stack>

      <Slider
        size="small"
        aria-label="Discovery timeline"
        value={Math.min(stopIndex, lastIndex)}
        min={0}
        max={lastIndex}
        // `step={null}` makes the handle snap to the marks — one real discovery
        // event per position, with no meaningless space in between.
        step={null}
        marks={marks}
        onChange={(_, value) => {
          stop();
          onStopIndexChange(typeof value === "number" ? value : value[0]);
        }}
        sx={{
          flex: "1 1 200px",
          minWidth: 140,
          color: colors.ion,
          "& .MuiSlider-rail": { opacity: 0.28 },
          "& .MuiSlider-mark": {
            height: 7,
            width: 1.5,
            bgcolor: colors.edgeHi,
            "&.MuiSlider-markActive": { bgcolor: colors.ionBright },
          },
          "& .MuiSlider-thumb": {
            height: 12,
            width: 12,
            "&:hover, &.Mui-focusVisible": { boxShadow: `0 0 0 6px rgba(76,141,255,0.18)` },
          },
        }}
      />

      {label}
    </Stack>
  );
}

export default DiscoveryScrubber;
