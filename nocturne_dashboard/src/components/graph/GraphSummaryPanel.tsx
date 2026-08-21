"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { RefreshCw, Sparkles } from "lucide-react";

import { colors, fonts } from "@/theme/tokens";
import type { KnowledgeGraphView } from "@/types/dashboard";

/**
 * The model's reading of the graph currently on screen.
 *
 * Lives in the inspector's empty state on purpose. The inspector already
 * answers "what is this thing I clicked"; this answers the question an analyst
 * has *before* clicking anything, which is what the shape of the graph is
 * supposed to mean. Once a node or edge is selected the specific answer is more
 * useful than the general one, so this yields the panel.
 */

export interface GraphSummaryPanelProps {
  orgId: string;
  view: KnowledgeGraphView;
  incidentKey: string | null;
  /**
   * Changes whenever the underlying graph changes. Used to re-request, so
   * switching incident or view does not leave the previous graph's reading on
   * screen next to a different picture.
   */
  graphSignature: string;
}

interface SummaryState {
  summary: string;
  generatedAt: string;
  modelName: string;
  cached: boolean;
}

export function GraphSummaryPanel({
  orgId,
  view,
  incidentKey,
  graphSignature,
}: GraphSummaryPanelProps) {
  const [state, setState] = useState<SummaryState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/knowledge-graph/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgId, view, incidentKey, force }),
        });
        const body = (await response.json()) as SummaryState & { error?: string };
        if (!response.ok) {
          throw new Error(body.error ?? "The summary could not be generated.");
        }
        setState(body);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "The summary could not be generated.",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [incidentKey, orgId, view],
  );

  // Re-reads whenever the graph identity changes. The server answers from its
  // cache unless the graph's fingerprint moved, so this is one round trip and
  // not one model call per view.
  useEffect(() => {
    void load(false);
  }, [load, graphSignature]);

  return (
    <Stack gap={1.2}>
      <Stack direction="row" alignItems="center" gap={0.8}>
        <Sparkles size={13} color={colors.ion} />
        <Typography variant="overline" sx={{ color: colors.text2 }}>
          What this graph shows
        </Typography>
        <Box sx={{ ml: "auto" }}>
          <Button
            size="small"
            variant="text"
            disabled={isLoading}
            startIcon={
              isLoading ? (
                <CircularProgress size={11} color="inherit" />
              ) : (
                <RefreshCw size={11} />
              )
            }
            onClick={() => void load(true)}
            sx={{ fontSize: 10, color: colors.text3, minWidth: 0, px: 0.6 }}
          >
            {isLoading ? "Reading" : "Redo"}
          </Button>
        </Box>
      </Stack>

      {isLoading && !state ? (
        <Typography sx={{ fontSize: 11.5, color: colors.text3, lineHeight: 1.7 }}>
          Reading the relationships…
        </Typography>
      ) : error ? (
        <Typography sx={{ fontSize: 11.5, color: colors.medium, lineHeight: 1.7 }}>
          {error}
        </Typography>
      ) : state ? (
        <>
          {state.summary.split(/\n\s*\n/).map((paragraph, index) => (
            <Typography
              key={index}
              sx={{ fontSize: 12, color: colors.text2, lineHeight: 1.75 }}
            >
              {paragraph.trim()}
            </Typography>
          ))}
          {/* Named as model output, not as a finding. An analyst has to be able
              to tell at a glance which text on this page came from the cascade's
              verified evidence and which came from a language model reading it. */}
          <Typography
            sx={{
              fontFamily: fonts.mono,
              fontSize: 9.5,
              color: colors.text3,
              mt: 0.4,
            }}
          >
            AI-GENERATED · {state.modelName.toUpperCase()}
            {state.cached ? " · CACHED" : ""}
          </Typography>
        </>
      ) : null}
    </Stack>
  );
}
