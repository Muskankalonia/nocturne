"use client";

import { useCallback, useMemo, useState } from "react";
import { Box, Checkbox, Stack, Typography } from "@mui/material";
import { Search } from "lucide-react";
import { useGridFilter, type CustomFilterProps } from "ag-grid-react";
import type { IRowNode } from "ag-grid-community";
import { colors, fonts, layout } from "@/theme/tokens";

/**
 * A set-style checkbox column filter.
 *
 * AG Grid's own Set Filter (`agSetColumnFilter`) is an Enterprise feature and is
 * not in the Community bundle this project ships. Rather than take an Enterprise
 * licence — and the watermark that comes with a trial key — this implements the
 * same interaction against Community's custom-filter API: distinct values pulled
 * from the loaded rows, each with a checkbox, plus a search box and
 * select-all/clear.
 *
 * The model is the array of *selected* values. `null` means no filter, which is
 * how AG Grid distinguishes "inactive" from "nothing selected" — and those are
 * genuinely different: nothing selected must show zero rows.
 */

type Model = string[] | null;

/** How a cell becomes the label a person ticks. */
function valuesFor(node: IRowNode, field: string | undefined): string[] {
  if (!field) return [];
  const raw = (node.data as Record<string, unknown> | undefined)?.[field];
  if (raw === null || raw === undefined || raw === "") return ["(none)"];
  // Array-valued columns — leak types, aliases — contribute each member
  // separately, so ticking "Credentials" matches every row containing it.
  if (Array.isArray(raw)) {
    return raw.length ? raw.map((v) => String(v)) : ["(none)"];
  }
  return [String(raw)];
}

/** Opt-in per column: `filterParams: { valueLabel: leakTypeLabel }`. */
export interface CheckboxFilterParams {
  valueLabel?: Record<string, string> | ((value: string) => string);
}

export function CheckboxFilter(props: CustomFilterProps<unknown, unknown, Model>) {
  const { model, onModelChange, api, colDef } = props;
  const field = colDef?.field;
  const [query, setQuery] = useState("");

  // Filter values are stored as the raw enum the pipeline emits, but nobody
  // outside the team reads `malware_exploit`. Ticking happens against the label.
  const params = colDef?.filterParams as CheckboxFilterParams | undefined;
  const labelOf = useCallback(
    (value: string) => {
      const map = params?.valueLabel;
      if (!map) return value;
      const label = typeof map === "function" ? map(value) : map[value];
      return label ?? value;
    },
    [params],
  );

  /** Every distinct value present in the currently loaded rows, sorted. */
  const options = useMemo(() => {
    const seen = new Set<string>();
    api.forEachLeafNode((node) => {
      for (const value of valuesFor(node, field)) seen.add(value);
    });
    return [...seen].sort((a, b) =>
      labelOf(a).localeCompare(labelOf(b), undefined, { numeric: true }));
    // `model` is in the deps so the list rebuilds when the grid's data changes
    // underneath an open filter popup.
  }, [api, field, labelOf, model]);

  const selected = useMemo(
    () => new Set(model ?? options),
    [model, options],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => labelOf(o).toLowerCase().includes(q)) : options;
  }, [labelOf, options, query]);

  const commit = useCallback(
    (next: Set<string>) => {
      // All values ticked is indistinguishable from no filter, and reporting it
      // as inactive keeps the column's filter icon honest.
      onModelChange(next.size === options.length ? null : [...next]);
    },
    [onModelChange, options.length],
  );

  const toggle = useCallback(
    (value: string) => {
      const next = new Set(selected);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      commit(next);
    },
    [commit, selected],
  );

  useGridFilter({
    doesFilterPass: ({ node }) => {
      if (!model) return true;
      const allowed = new Set(model);
      return valuesFor(node, field).some((value) => allowed.has(value));
    },
    // A model of [] is active and matches nothing — that is the correct result
    // of the user clearing every box.
    afterGuiAttached: () => setQuery(""),
  });

  const allVisibleSelected = visible.length > 0 && visible.every((v) => selected.has(v));

  return (
    <Box sx={{ width: 232, p: 1, backgroundColor: colors.hull }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.8,
          px: 1,
          py: 0.5,
          mb: 0.8,
          borderRadius: `${layout.radiusSm}px`,
          border: `1px solid ${colors.edge}`,
          backgroundColor: colors.void,
        }}
      >
        <Search size={12} color={colors.text3} />
        <Box
          component="input"
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder="Search values…"
          aria-label={`Search ${colDef?.headerName ?? "values"}`}
          sx={{
            flex: 1,
            minWidth: 0,
            border: 0,
            outline: "none",
            background: "transparent",
            color: colors.text1,
            fontFamily: fonts.sans,
            fontSize: 12,
            "&::placeholder": { color: colors.text3 },
          }}
        />
      </Box>

      <Stack
        direction="row"
        gap={1.5}
        sx={{ px: 0.5, pb: 0.6, borderBottom: `1px solid ${colors.edge}` }}
      >
        <Box
          component="button"
          type="button"
          onClick={() => commit(new Set([...selected, ...visible]))}
          sx={selectAllSx}
        >
          Select all
        </Box>
        <Box
          component="button"
          type="button"
          onClick={() => {
            const next = new Set(selected);
            for (const v of visible) next.delete(v);
            commit(next);
          }}
          sx={selectAllSx}
        >
          Clear
        </Box>
        <Typography
          sx={{
            ml: "auto",
            fontFamily: fonts.mono,
            fontSize: 9.5,
            color: colors.text3,
            alignSelf: "center",
          }}
        >
          {selected.size}/{options.length}
        </Typography>
      </Stack>

      <Box sx={{ maxHeight: 236, overflowY: "auto", mt: 0.4 }}>
        {visible.length === 0 && (
          <Typography sx={{ p: 1, fontSize: 11.5, color: colors.text3 }}>
            No values match “{query}”.
          </Typography>
        )}
        {visible.map((value) => (
          <Box
            component="label"
            key={value}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.4,
              px: 0.5,
              borderRadius: `${layout.radiusSm}px`,
              cursor: "pointer",
              "&:hover": { backgroundColor: "rgba(255,255,255,0.045)" },
            }}
          >
            <Checkbox
              size="small"
              checked={selected.has(value)}
              onChange={() => toggle(value)}
              sx={{
                p: 0.5,
                color: colors.text3,
                "&.Mui-checked": { color: colors.ion },
              }}
            />
            <Typography
              sx={{
                fontSize: 12,
                color: selected.has(value) ? colors.text1 : colors.text2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={value}
            >
              {labelOf(value)}
            </Typography>
          </Box>
        ))}
      </Box>

      {!allVisibleSelected && visible.length > 0 && (
        <Typography
          sx={{
            mt: 0.6,
            pt: 0.6,
            borderTop: `1px solid ${colors.edge}`,
            fontFamily: fonts.mono,
            fontSize: 9.5,
            color: colors.text3,
          }}
        >
          Filter active
        </Typography>
      )}
    </Box>
  );
}

const selectAllSx = {
  border: 0,
  background: "transparent",
  cursor: "pointer",
  p: 0,
  fontFamily: fonts.mono,
  fontSize: 9.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  color: colors.ion,
  "&:hover": { color: colors.ionBright },
  "&:focus-visible": { outline: `2px solid ${colors.ion}`, outlineOffset: 2 },
};

export default CheckboxFilter;
