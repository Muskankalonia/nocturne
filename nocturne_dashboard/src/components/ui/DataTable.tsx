"use client";

import { useCallback, useRef, useState, type ReactNode, type Ref } from "react";
import { Box, InputBase, Stack, Typography, alpha } from "@mui/material";
import { Search, X } from "lucide-react";
import { AgGridReact, type AgGridReactProps } from "ag-grid-react";
import type { ColDef, GridReadyEvent, SelectionChangedEvent } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import { colors, fonts, shadows } from "@/theme/tokens";
import { CheckboxFilter } from "@/components/ui/CheckboxFilter";

export const defaultColDef: ColDef = {
  sortable: true,
  // Every column filters by ticking values rather than typing a substring.
  // AG Grid's own set filter is Enterprise; CheckboxFilter is the Community
  // equivalent built on the custom-filter API. A column can still opt back in
  // to free text with `filter: "agTextColumnFilter"`.
  filter: CheckboxFilter,
  resizable: true,
  flex: 1,
  minWidth: 110,
};

export interface DataTableProps<T> extends AgGridReactProps<T> {
  height?: number | string;
  /**
   * Named explicitly rather than relying on `ref` — a generic function
   * component cannot forward a typed ref cleanly, and CSV export needs the API.
   */
  gridRef?: Ref<AgGridReact<T>>;
  /** Renders the search box + selection summary above the grid. */
  toolbar?: boolean;
  searchPlaceholder?: string;
  /** Adds a checkbox column and enables multi-row selection. */
  selectable?: boolean;
  onSelectionCountChange?: (count: number) => void;
  /** Extra controls pinned to the right of the toolbar. */
  toolbarActions?: ReactNode;
}

/**
 * AG Grid Community, restyled onto the Nocturne palette.
 *
 * Community covers everything here: sort, multi-filter, quick search, row
 * selection, pagination, pinning, virtualization and CSV export.
 */
export function DataTable<T>({
  height = 460,
  gridRef,
  toolbar = true,
  searchPlaceholder = "Filter these rows…",
  selectable = true,
  onSelectionCountChange,
  toolbarActions,
  columnDefs,
  ...props
}: DataTableProps<T>) {
  const [quickFilter, setQuickFilter] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiRef = useRef<any>(null);

  const handleGridReady = useCallback(
    (e: GridReadyEvent<T>) => {
      apiRef.current = e.api;
      setVisibleCount(e.api.getDisplayedRowCount());
      props.onGridReady?.(e);
    },
    [props],
  );

  const handleSelectionChanged = useCallback(
    (e: SelectionChangedEvent<T>) => {
      const n = e.api.getSelectedRows().length;
      setSelectedCount(n);
      onSelectionCountChange?.(n);
      props.onSelectionChanged?.(e);
    },
    [onSelectionCountChange, props],
  );

  const cols: ColDef<T>[] | undefined = selectable
    ? ([
        {
          colId: "__select",
          headerName: "",
          width: 46,
          minWidth: 46,
          maxWidth: 46,
          flex: 0,
          pinned: "left",
          sortable: false,
          filter: false,
          resizable: false,
          checkboxSelection: true,
          headerCheckboxSelection: true,
          headerCheckboxSelectionFilteredOnly: true,
        },
        ...(columnDefs ?? []),
      ] as ColDef<T>[])
    : (columnDefs as ColDef<T>[] | undefined);

  // `height="100%"` only means anything if this wrapper has a definite height
  // of its own. As a plain block it does not, so the percentage would silently
  // collapse to the grid's intrinsic height. Becoming a flex column lets the
  // caller's flex context size us, and the grid below claims what is left after
  // the toolbar.
  const fills = height === "100%";

  return (
    <Box
      sx={{
        minWidth: 0,
        ...(fills
          ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }
          : null),
      }}
    >
      {toolbar && (
        <Stack
          direction="row"
          gap={1.2}
          alignItems="center"
          flexWrap="wrap"
          sx={{ mb: 1.5, flexShrink: 0 }}
        >
          <Stack
            direction="row"
            alignItems="center"
            gap={1}
            sx={{
              flex: 1,
              minWidth: 220,
              maxWidth: 360,
              px: 1.3,
              py: 0.7,
              borderRadius: "7px",
              border: `1px solid ${colors.edge}`,
              backgroundColor: "rgba(6,11,20,0.8)",
              "&:focus-within": {
                borderColor: alpha(colors.ion, 0.5),
                boxShadow: `0 0 0 3px ${alpha(colors.ion, 0.1)}`,
              },
            }}
          >
            <Search size={13} color={colors.text3} />
            <InputBase
              value={quickFilter}
              onChange={(e) => {
                setQuickFilter(e.target.value);
                apiRef.current?.setGridOption("quickFilterText", e.target.value);
                // Row count updates after the filter is applied.
                queueMicrotask(() =>
                  setVisibleCount(apiRef.current?.getDisplayedRowCount() ?? null),
                );
              }}
              placeholder={searchPlaceholder}
              inputProps={{ "aria-label": "Filter rows" }}
              sx={{
                flex: 1,
                fontSize: 12,
                color: colors.text1,
                "& input::placeholder": { color: colors.text3, opacity: 1 },
              }}
            />
            {quickFilter && (
              <Box
                component="button"
                type="button"
                aria-label="Clear filter"
                onClick={() => {
                  setQuickFilter("");
                  apiRef.current?.setGridOption("quickFilterText", "");
                  queueMicrotask(() =>
                    setVisibleCount(apiRef.current?.getDisplayedRowCount() ?? null),
                  );
                }}
                sx={{
                  border: 0,
                  background: "none",
                  cursor: "pointer",
                  color: colors.text3,
                  display: "flex",
                  p: 0,
                  "&:hover": { color: colors.text1 },
                }}
              >
                <X size={13} />
              </Box>
            )}
          </Stack>

          {selectedCount > 0 && (
            <Stack
              direction="row"
              alignItems="center"
              gap={1}
              sx={{
                px: 1.2,
                py: 0.6,
                borderRadius: "6px",
                border: `1px solid ${alpha(colors.ion, 0.35)}`,
                backgroundColor: alpha(colors.ion, 0.08),
              }}
            >
              <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.ion }}>
                {selectedCount} selected
              </Typography>
              <Box
                component="button"
                type="button"
                onClick={() => apiRef.current?.deselectAll()}
                sx={{
                  border: 0,
                  background: "none",
                  cursor: "pointer",
                  color: colors.text3,
                  display: "flex",
                  p: 0,
                  "&:hover": { color: colors.text1 },
                }}
                aria-label="Clear selection"
              >
                <X size={12} />
              </Box>
            </Stack>
          )}

          {visibleCount !== null && (
            <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text3 }}>
              {visibleCount} row{visibleCount === 1 ? "" : "s"}
            </Typography>
          )}

          {toolbarActions && <Box sx={{ ml: "auto" }}>{toolbarActions}</Box>}
        </Stack>
      )}

      <Box
        className="ag-theme-quartz-dark"
        sx={{
          height,
          ...(fills ? { flex: 1, minHeight: 0 } : null),
          width: "100%",
          // Quartz exposes its tokens as CSS variables, so we recolour rather
          // than fight the theme with selector overrides.
          "--ag-background-color": "transparent",
          "--ag-foreground-color": colors.text1,
          "--ag-header-foreground-color": colors.text3,
          "--ag-header-background-color": alpha(colors.ion, 0.04),
          "--ag-border-color": colors.edge,
          "--ag-row-border-color": alpha(colors.ion, 0.08),
          "--ag-row-hover-color": alpha(colors.ion, 0.06),
          "--ag-selected-row-background-color": alpha(colors.ion, 0.14),
          "--ag-odd-row-background-color": "transparent",
          "--ag-font-family": fonts.sans,
          "--ag-font-size": "12px",
          "--ag-grid-size": "5px",
          "--ag-cell-horizontal-padding": "12px",
          "--ag-borders": "none",
          "--ag-input-focus-border-color": colors.ion,
          "--ag-control-panel-background-color": colors.hullHi,
          "--ag-menu-background-color": colors.hullHi,
          "--ag-checkbox-checked-color": colors.ion,
          "--ag-checkbox-unchecked-color": colors.text3,
          "--ag-popup-shadow": shadows.menu,
          "& .ag-header-cell-text": {
            fontFamily: fonts.mono,
            fontSize: 9.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          },
          "& .ag-cell": { display: "flex", alignItems: "center" },
          // The selection column is a fixed 46px of pure control — the grid's
          // 12px text padding would shove the checkbox off-centre, so drop it
          // and centre the box in the column instead. Applies to the header's
          // select-all as well, so the two stay on one axis.
          '& .ag-cell[col-id="__select"], & .ag-header-cell[col-id="__select"]': {
            paddingLeft: 0,
            paddingRight: 0,
            justifyContent: "center",
          },
          // The header cell lays out the select-all checkbox and an empty
          // label/sort wrapper as two equal flex children, which centres the
          // checkbox in the left half rather than in the column. This column
          // has no header text and is not sortable, filterable or resizable,
          // so that wrapper renders nothing — collapse it and let the checkbox
          // span the full width.
          '& .ag-header-cell[col-id="__select"] .ag-header-cell-comp-wrapper': {
            display: "none",
          },
          '& .ag-header-cell[col-id="__select"] .ag-header-select-all': {
            flex: 1,
            justifyContent: "center",
            marginRight: 0,
          },
          '& .ag-cell[col-id="__select"] .ag-selection-checkbox': { marginRight: 0 },
          "& .row-critical .ag-cell:first-of-type": { boxShadow: `inset 2px 0 0 ${colors.critical}` },
          "& .row-high .ag-cell:first-of-type": { boxShadow: `inset 2px 0 0 ${colors.high}` },
          "& .row-medium .ag-cell:first-of-type": { boxShadow: `inset 2px 0 0 ${colors.medium}` },
          "& .row-low .ag-cell:first-of-type": { boxShadow: `inset 2px 0 0 ${colors.low}` },
          "& .row-informational .ag-cell:first-of-type": {
            boxShadow: `inset 2px 0 0 ${colors.informational}`,
          },
          "& .row-critical": {
            background: "linear-gradient(90deg, rgba(255,59,92,0.09), transparent 42%)",
          },
          "& .ag-row-hover.row-critical": {
            background: "linear-gradient(90deg, rgba(255,59,92,0.14), transparent 42%)",
          },
          "& .ag-overlay-no-rows-center": { color: colors.text3, fontSize: 12 },
        }}
      >
        <AgGridReact<T>
          ref={gridRef}
          columnDefs={cols}
          defaultColDef={defaultColDef}
          animateRows={false}
          rowHeight={46}
          headerHeight={38}
          suppressCellFocus
          rowSelection={selectable ? "multiple" : undefined}
          suppressRowClickSelection={selectable}
          overlayNoRowsTemplate={'<span class="ag-overlay-no-rows-center">No rows match this filter</span>'}
          {...props}
          onGridReady={handleGridReady}
          onSelectionChanged={handleSelectionChanged}
        />
      </Box>
    </Box>
  );
}

export default DataTable;
