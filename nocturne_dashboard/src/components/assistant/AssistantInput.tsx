"use client";

import { useState, useRef, type KeyboardEvent } from "react";
import { Box, IconButton, InputBase, alpha } from "@mui/material";
import { SendHorizonal } from "lucide-react";
import { colors, fonts, layout } from "@/theme/tokens";

interface AssistantInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function AssistantInput({ onSend, disabled }: AssistantInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        p: 1.5,
        borderTop: `1px solid ${colors.edge}`,
        backgroundColor: alpha(colors.hull, 0.5),
      }}
    >
      <InputBase
        inputRef={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask about your data..."
        disabled={disabled}
        multiline
        maxRows={4}
        sx={{
          flex: 1,
          px: 1.5,
          py: 0.8,
          fontSize: 13,
          fontFamily: fonts.sans,
          color: colors.text1,
          backgroundColor: alpha(colors.void, 0.6),
          borderRadius: `${layout.radiusSm}px`,
          border: `1px solid ${colors.edge}`,
          "&.Mui-focused": {
            borderColor: alpha(colors.ion, 0.5),
          },
          "& .MuiInputBase-input::placeholder": {
            color: colors.text3,
            opacity: 1,
          },
        }}
      />
      <IconButton
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        size="small"
        sx={{
          color: colors.ion,
          "&:hover": { backgroundColor: alpha(colors.ion, 0.1) },
          "&.Mui-disabled": { color: colors.text3 },
        }}
      >
        <SendHorizonal size={18} />
      </IconButton>
    </Box>
  );
}
