"use client";

import { useState, useRef } from "react";
import { Box, Drawer, IconButton, Stack, Tooltip, Typography, alpha } from "@mui/material";
import { X, Trash2 } from "lucide-react";
import { colors, fonts, layout } from "@/theme/tokens";
import { useAssistant } from "./useAssistant";
import { AssistantMessageList } from "./AssistantMessageList";
import { AssistantInput } from "./AssistantInput";

const DRAWER_WIDTH = 420;

interface AssistantDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function AssistantDrawer({ open, onClose }: AssistantDrawerProps) {
  const { messages, isLoading, error, sendMessage, clearMessages } =
    useAssistant();

  const handleSuggestionClick = (suggestion: string) => {
    sendMessage(suggestion);
  };

  return (
    <>
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        variant="temporary"
        sx={{
          zIndex: 1300,
          "& .MuiDrawer-paper": {
            width: DRAWER_WIDTH,
            maxWidth: "100vw",
            height: "100vh",
            backgroundColor: colors.void,
            borderLeft: `1px solid ${colors.edge}`,
            backgroundImage: "none",
          },
        }}
      >
        <Stack sx={{ height: "100%", overflow: "hidden" }}>
          {/* Header */}
          <Stack
            direction="row"
            alignItems="center"
            gap={1}
            sx={{
              px: 2,
              py: 1.5,
              borderBottom: `1px solid ${colors.edge}`,
              flexShrink: 0,
            }}
          >
            <Box
              component="img"
              src="/nocturne-mark.png"
              alt="Nox"
              width={20}
              height={20}
              sx={{ display: "block", flexShrink: 0, borderRadius: 1 }}
            />
            <Typography
              sx={{
                fontSize: 13,
                fontWeight: 600,
                color: colors.text1,
                fontFamily: fonts.sans,
                flex: 1,
              }}
            >
              Nox
            </Typography>
            {messages.length > 0 && (
              <IconButton
                size="small"
                onClick={clearMessages}
                title="Clear conversation"
                sx={{
                  color: colors.text3,
                  "&:hover": { color: colors.text2 },
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            )}
            <IconButton
              size="small"
              onClick={onClose}
              sx={{
                color: colors.text3,
                "&:hover": { color: colors.text1 },
              }}
            >
              <X size={16} />
            </IconButton>
          </Stack>

          {/* Error banner */}
          {error && (
            <Box
              sx={{
                px: 2,
                py: 1,
                backgroundColor: alpha(colors.critical, 0.1),
                borderBottom: `1px solid ${alpha(colors.critical, 0.2)}`,
              }}
            >
              <Typography sx={{ fontSize: 12, color: colors.critical }}>
                {error}
              </Typography>
            </Box>
          )}

          {/* Messages */}
          <AssistantMessageList
            messages={messages}
            onSuggestionClick={handleSuggestionClick}
          />

          {/* Input */}
          <AssistantInput onSend={sendMessage} disabled={isLoading} />
        </Stack>
      </Drawer>
    </>
  );
}

/* ── Floating Action Button (bottom-right, draggable) ──────────────────────── */

interface UmbraFabProps {
  onClick: () => void;
  visible: boolean;
}

export function UmbraFab({ onClick, visible }: UmbraFabProps) {
  const [position, setPosition] = useState({ x: 24, y: 24 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const didDrag = useRef(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    dragStart.current = { x: e.clientX, y: e.clientY, px: position.x, py: position.y };
    didDrag.current = false;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      didDrag.current = true;
    }
    const newX = Math.max(8, dragStart.current.px - dx);
    const newY = Math.max(8, dragStart.current.py - dy);
    setPosition({
      x: Math.min(newX, window.innerWidth - 60),
      y: Math.min(newY, window.innerHeight - 60),
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    dragStart.current = null;
    setDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (!didDrag.current) {
      onClick();
    }
  };

  if (!visible) return null;

  return (
    <Tooltip title="Nox" placement="left">
      <Box
        component="button"
        type="button"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        sx={{
          position: "fixed",
          bottom: position.y,
          right: position.x,
          zIndex: 1200,
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: `1.5px solid ${alpha(colors.ion, 0.4)}`,
          backgroundColor: colors.hull,
          boxShadow: `0 4px 20px ${alpha(colors.ion, 0.25)}, 0 0 40px ${alpha(colors.ion, 0.08)}`,
          cursor: dragging ? "grabbing" : "grab",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: dragging ? "none" : "box-shadow 0.2s ease, border-color 0.2s ease",
          touchAction: "none",
          userSelect: "none",
          "&:hover": {
            boxShadow: `0 6px 28px ${alpha(colors.ion, 0.35)}, 0 0 50px ${alpha(colors.ion, 0.12)}`,
            borderColor: colors.ion,
          },
          "&:focus-visible": {
            outline: `2px solid ${colors.ion}`,
            outlineOffset: 3,
          },
        }}
      >
        <Box
          component="img"
          src="/nocturne-mark.png"
          alt="Nox"
          width={28}
          height={28}
          sx={{ display: "block", borderRadius: "50%", pointerEvents: "none" }}
        />
      </Box>
    </Tooltip>
  );
}
