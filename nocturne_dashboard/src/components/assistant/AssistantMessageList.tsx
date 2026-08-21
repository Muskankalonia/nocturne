"use client";

import { useRef, useEffect, useState } from "react";
import { Box, Stack, Typography, Chip, CircularProgress, alpha, Dialog, IconButton as MuiIconButton } from "@mui/material";
import { ExternalLink, Maximize2, X } from "lucide-react";
import { colors, fonts } from "@/theme/tokens";
import type { ChatMessage } from "./useAssistant";
import React from "react";

interface AssistantMessageListProps {
  messages: ChatMessage[];
  onSuggestionClick: (suggestion: string) => void;
}

export function AssistantMessageList({
  messages,
  onSuggestionClick,
}: AssistantMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2.5,
          p: 3,
        }}
      >
        <Typography
          sx={{
            color: colors.text1,
            fontSize: 15,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Hi, I'm Nox
        </Typography>
        <Typography
          sx={{
            color: colors.text2,
            fontSize: 13,
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          Your dark-web intelligence assistant. Ask me anything about your breached data.
        </Typography>
        <Stack gap={1} sx={{ width: "100%", mt: 1 }}>
          {[
            "What's my current breach posture?",
            "Who are the most credible threat actors?",
            "Show me all critical severity incidents",
          ].map((suggestion) => (
            <Chip
              key={suggestion}
              label={suggestion}
              size="small"
              onClick={() => onSuggestionClick(suggestion)}
              sx={{
                fontSize: 12,
                height: "auto",
                "& .MuiChip-label": {
                  whiteSpace: "normal",
                  py: 0.6,
                },
                color: colors.ion,
                borderColor: alpha(colors.ion, 0.3),
                "&:hover": { backgroundColor: alpha(colors.ion, 0.1) },
              }}
              variant="outlined"
            />
          ))}
        </Stack>
      </Box>
    );
  }

  return (
    <Stack sx={{ flex: 1, overflow: "auto", p: 2, gap: 2 }}>
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onSuggestionClick={onSuggestionClick}
        />
      ))}
      <div ref={bottomRef} />
    </Stack>
  );
}

function MessageBubble({
  message,
  onSuggestionClick,
}: {
  message: ChatMessage;
  onSuggestionClick: (s: string) => void;
}) {
  const isUser = message.role === "user";

  return (
    <Box
      sx={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "88%",
      }}
    >
      <Box
        sx={{
          px: 1.8,
          py: 1.2,
          borderRadius: 2,
          backgroundColor: isUser
            ? alpha(colors.ion, 0.12)
            : alpha(colors.hull, 0.8),
          border: `1px solid ${isUser ? alpha(colors.ion, 0.3) : colors.edge}`,
        }}
      >
        {message.loading ? (
          <Stack direction="row" alignItems="center" gap={1}>
            <CircularProgress size={14} sx={{ color: colors.ion }} />
            <Typography sx={{ color: colors.text2, fontSize: 13 }}>
              Thinking...
            </Typography>
          </Stack>
        ) : (
          <Box
            component="div"
            sx={{
              color: colors.text1,
              fontSize: 13,
              lineHeight: 1.7,
              fontFamily: fonts.sans,
              "& strong": { color: colors.ionBright, fontWeight: 600 },
              "& code": {
                fontFamily: fonts.mono,
                fontSize: 12,
                backgroundColor: alpha(colors.ion, 0.08),
                px: 0.5,
                borderRadius: 0.5,
              },
            }}
          >
            {formatMarkdown(message.content)}
          </Box>
        )}
      </Box>

      {/* Citations */}
      {message.citations && message.citations.length > 0 && (
        <Stack direction="row" gap={0.5} sx={{ mt: 0.8, flexWrap: "wrap" }}>
          {message.citations.map((citation) => (
            <Chip
              key={citation.key}
              label={citation.label}
              size="small"
              icon={<ExternalLink size={10} />}
              component="a"
              href={`/leaks/${citation.key}`}
              clickable
              sx={{
                fontSize: 10,
                height: 22,
                color: colors.verified,
                borderColor: alpha(colors.verified, 0.3),
                "& .MuiChip-icon": { color: colors.verified },
              }}
              variant="outlined"
            />
          ))}
        </Stack>
      )}

      {/* Suggested follow-ups (only on last assistant message) */}
      {!isUser && message.suggestedFollowUps && message.suggestedFollowUps.length > 0 && (
        <Stack gap={0.5} sx={{ mt: 1, flexWrap: "wrap" }}>
          {message.suggestedFollowUps.map((suggestion) => (
            <Chip
              key={suggestion}
              label={suggestion}
              size="small"
              onClick={() => onSuggestionClick(suggestion)}
              sx={{
                fontSize: 11,
                height: "auto",
                "& .MuiChip-label": {
                  whiteSpace: "normal",
                  py: 0.5,
                },
                color: colors.text2,
                borderColor: colors.edge,
                "&:hover": {
                  backgroundColor: alpha(colors.ion, 0.08),
                  color: colors.ion,
                },
              }}
              variant="outlined"
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

/** Render markdown: tables, bold, inline code, headers, bullets. */
function formatMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect markdown table (line with |)
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(
        <MarkdownTable key={`table-${i}`} lines={tableLines} />,
      );
      continue;
    }

    // Headers
    if (line.startsWith("## ")) {
      elements.push(
        <span key={`h-${i}`} style={{ fontWeight: 700, fontSize: 14, display: "block", marginTop: 12, marginBottom: 4 }}>
          {applyInlineFormatting(line.slice(3))}
        </span>,
      );
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      elements.push(
        <span key={`h3-${i}`} style={{ fontWeight: 600, fontSize: 13, display: "block", marginTop: 8, marginBottom: 2 }}>
          {applyInlineFormatting(line.slice(4))}
        </span>,
      );
      i++;
      continue;
    }

    // Bullet points
    if (line.match(/^[-*] /)) {
      elements.push(
        <span key={`li-${i}`} style={{ display: "block", paddingLeft: 12 }}>
          {"• "}{applyInlineFormatting(line.slice(2))}
        </span>,
      );
      i++;
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\. /)) {
      const num = line.match(/^(\d+)\. /)?.[1];
      const content = line.replace(/^\d+\. /, "");
      elements.push(
        <span key={`ol-${i}`} style={{ display: "block", paddingLeft: 12 }}>
          {num}. {applyInlineFormatting(content)}
        </span>,
      );
      i++;
      continue;
    }

    // Empty line = spacing
    if (line.trim() === "") {
      elements.push(<span key={`br-${i}`} style={{ display: "block", height: 8 }} />);
      i++;
      continue;
    }

    // Normal text with inline formatting
    elements.push(
      <span key={`p-${i}`} style={{ display: "block" }}>
        {applyInlineFormatting(line)}
      </span>,
    );
    i++;
  }

  return <>{elements}</>;
}

function applyInlineFormatting(text: string): React.ReactNode {
  // Split on **bold**, `code`, and [link](url) patterns
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={match.index} style={{ color: colors.ionBright, fontWeight: 600 }}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <code key={match.index} style={{ fontFamily: "var(--font-mono)", fontSize: 12, backgroundColor: "rgba(76,141,255,0.08)", padding: "1px 4px", borderRadius: 3 }}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      // Markdown link: [text](url)
      const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        parts.push(
          <a
            key={match.index}
            href={linkMatch[2]}
            style={{
              color: colors.ion,
              textDecoration: "none",
              borderBottom: `1px solid rgba(76,141,255,0.4)`,
              fontWeight: 500,
            }}
          >
            {linkMatch[1]}
          </a>,
        );
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const [fullscreen, setFullscreen] = useState(false);

  if (lines.length < 2) return null;

  const parseRow = (line: string) =>
    line.split("|").slice(1, -1).map((cell) => cell.trim());

  const headers = parseRow(lines[0]);
  // Skip separator line (---|---|---)
  const startIdx = lines[1].includes("---") ? 2 : 1;
  const rows = lines.slice(startIdx).map(parseRow);

  const tableContent = (
    <Box
      component="table"
      sx={{
        width: "100%",
        minWidth: "max-content",
        fontSize: 12,
        borderCollapse: "collapse",
        "& th": {
          textAlign: "left",
          px: 1.2,
          py: 0.7,
          borderBottom: `1px solid ${colors.edge}`,
          color: colors.text2,
          fontWeight: 600,
          fontSize: 11,
          whiteSpace: "nowrap",
        },
        "& td": {
          px: 1.2,
          py: 0.6,
          borderBottom: `1px solid rgba(104,146,224,0.06)`,
          color: colors.text1,
          whiteSpace: "nowrap",
        },
      }}
    >
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td key={ci}>{applyInlineFormatting(cell)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </Box>
  );

  return (
    <>
      <Box sx={{ position: "relative", my: 1 }}>
        <Box
          sx={{
            overflowX: "auto",
            borderRadius: 1,
            border: `1px solid ${colors.edge}`,
            backgroundColor: alpha(colors.hull, 0.4),
            p: 0.5,
          }}
        >
          {tableContent}
        </Box>
        <MuiIconButton
          size="small"
          onClick={() => setFullscreen(true)}
          title="View fullscreen"
          sx={{
            position: "absolute",
            top: 4,
            right: 4,
            color: colors.text3,
            backgroundColor: alpha(colors.hull, 0.9),
            "&:hover": { color: colors.ion, backgroundColor: colors.hull },
            width: 24,
            height: 24,
          }}
        >
          <Maximize2 size={12} />
        </MuiIconButton>
      </Box>

      <Dialog
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        maxWidth={false}
        PaperProps={{
          sx: {
            backgroundColor: colors.void,
            border: `1px solid ${colors.edge}`,
            borderRadius: 2,
            p: 2,
            maxWidth: "90vw",
            maxHeight: "80vh",
            overflow: "auto",
          },
        }}
      >
        <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
          <MuiIconButton
            size="small"
            onClick={() => setFullscreen(false)}
            sx={{ color: colors.text3, "&:hover": { color: colors.text1 } }}
          >
            <X size={16} />
          </MuiIconButton>
        </Stack>
        {tableContent}
      </Dialog>
    </>
  );
}
