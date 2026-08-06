"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  Stack,
  TextField,
  Typography,
  alpha,
} from "@mui/material";
import { useAuth } from "@/contexts/AuthContext";
import { colors, fonts, gradients, layout, shadows } from "@/theme/tokens";

/**
 * Self-service profile editing.
 *
 * Only three fields are here, and the omissions are deliberate: role, tenant
 * and username decide what this account may read, so they are shown read-only
 * and come from the signed session. A user renaming themselves changes what the
 * chrome says, never what they can see.
 */

interface ProfileShape {
  displayName: string;
  email: string | null;
  position: string | null;
  /** Carried through untouched — the PUT replaces the whole record, so
    * omitting these here would clear the user's alert settings. */
  alertBands?: string[];
  weeklyDigest?: boolean;
  updatedAt?: string | null;
}

export function UserSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { session, isSuperAdmin, applyProfile } = useAuth();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [position, setPosition] = useState("");
  const [alerts, setAlerts] = useState<{ alertBands: string[]; weeklyDigest: boolean }>({
    alertBands: [],
    weeklyDigest: true,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seed = useCallback((profile: ProfileShape) => {
    setDisplayName(profile.displayName ?? "");
    setEmail(profile.email ?? "");
    setPosition(profile.position ?? "");
    setAlerts({
      alertBands: profile.alertBands ?? [],
      weeklyDigest: profile.weeklyDigest ?? true,
    });
  }, []);

  // Refetch each time it opens: another tab may have saved since last time.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await fetch("/api/user-profile", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body = (await response.json()) as
          | { profile: ProfileShape }
          | { error?: string };
        if (!response.ok || !("profile" in body)) {
          throw new Error(
            "error" in body && body.error ? body.error : "Unable to load your profile.",
          );
        }
        seed(body.profile);
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        // Fall back to whatever the session already knows so the form is still
        // usable and the user is not staring at an empty dialog.
        if (session) {
          seed({
            displayName: session.user.displayName,
            email: session.user.email,
            position: session.user.position,
          });
        }
        setError(
          loadError instanceof Error ? loadError.message : "Unable to load your profile.",
        );
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [open, seed, session]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/user-profile", {
        method: "PUT",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          email: email.trim() || null,
          position: position.trim() || null,
          // Clearing the address would leave alerts armed with nowhere to send,
          // which the API rejects — drop the bands with it.
          alertBands: email.trim() ? alerts.alertBands : [],
          weeklyDigest: alerts.weeklyDigest,
        }),
      });
      const body = (await response.json()) as
        | { profile: ProfileShape }
        | { error?: string };
      if (!response.ok || !("profile" in body)) {
        throw new Error(
          "error" in body && body.error ? body.error : "Could not save your profile.",
        );
      }
      seed(body.profile);
      applyProfile({
        displayName: body.profile.displayName,
        email: body.profile.email,
        position: body.profile.position,
      });
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Could not save your profile.",
      );
    } finally {
      setIsSaving(false);
    }
  }, [displayName, email, position, alerts, seed, applyProfile, onClose]);

  const canSave = displayName.trim().length > 0 && !isSaving && !isLoading;

  return (
    <Dialog
      open={open}
      onClose={isSaving ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            backgroundImage: gradients.panel,
            border: `1px solid ${colors.edgeHi}`,
            boxShadow: shadows.raised,
            borderRadius: `${layout.radius}px`,
            p: 3,
          },
        },
      }}
    >
      <Stack gap={2.4}>
        <Box>
          <Typography variant="h3">Your profile</Typography>
          <Typography sx={{ fontSize: 12.5, color: colors.text3, mt: 0.4 }}>
            How you appear across the console.
          </Typography>
        </Box>

        {error && (
          <Box
            sx={{
              border: `1px solid ${alpha(colors.critical, 0.35)}`,
              backgroundColor: alpha(colors.critical, 0.06),
              borderRadius: `${layout.radiusSm}px`,
              px: 1.5,
              py: 1,
              fontSize: 11.5,
              color: colors.critical,
            }}
          >
            {error}
          </Box>
        )}

        {isLoading ? (
          <Stack alignItems="center" gap={1.5} sx={{ py: 4 }}>
            <CircularProgress size={20} sx={{ color: colors.ion }} />
            <Typography sx={{ fontSize: 12, color: colors.text2 }}>
              Loading your profile…
            </Typography>
          </Stack>
        ) : (
          <Stack gap={2}>
            <Field label="Display name">
              <TextField
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
                fullWidth
                autoFocus
                inputProps={{ maxLength: 80 }}
                error={displayName.trim().length === 0}
                helperText={
                  displayName.trim().length === 0 ? "A display name is required." : undefined
                }
              />
            </Field>

            <Field label="Email">
              <TextField
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                type="email"
                fullWidth
                inputProps={{ maxLength: 254 }}
              />
            </Field>

            <Field label="Position">
              <TextField
                value={position}
                onChange={(event) => setPosition(event.target.value)}
                placeholder="Security Analyst"
                fullWidth
                inputProps={{ maxLength: 80 }}
              />
            </Field>

            {/* Read-only, and separated from the editable fields on purpose:
                these are authorization, not presentation. */}
            <Stack
              gap={0.8}
              sx={{
                pt: 1.6,
                borderTop: `1px solid ${colors.edge}`,
              }}
            >
              <ReadOnlyRow label="USERNAME" value={session?.user.username ?? "—"} />
              <ReadOnlyRow
                label="ACCESS"
                value={isSuperAdmin ? "Fleet access" : "Organization analyst"}
                accent={isSuperAdmin ? colors.critical : colors.text2}
              />
              <Typography sx={{ fontSize: 10.5, color: colors.text3, lineHeight: 1.6, mt: 0.4 }}>
                Access level and tenant are set by your administrator and cannot be
                changed here.
              </Typography>
            </Stack>
          </Stack>
        )}

        <Stack direction="row" gap={1.2} justifyContent="flex-end">
          <Button
            variant="outlined"
            onClick={onClose}
            disabled={isSaving}
            sx={{ borderColor: colors.edgeHi, color: colors.text2 }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSave()}
            disabled={!canSave}
            startIcon={isSaving ? <CircularProgress size={13} color="inherit" /> : undefined}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography
        component="label"
        sx={{
          display: "block",
          mb: 0.8,
          fontFamily: fonts.mono,
          fontSize: 10,
          letterSpacing: "0.13em",
          textTransform: "uppercase",
          color: colors.text3,
        }}
      >
        {label}
      </Typography>
      {children}
    </Box>
  );
}

function ReadOnlyRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <Stack direction="row" alignItems="center" gap={1}>
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 9.5,
          letterSpacing: "0.13em",
          color: colors.text3,
        }}
      >
        {label}
      </Typography>
      <Typography
        sx={{
          ml: "auto",
          fontFamily: fonts.mono,
          fontSize: 11,
          color: accent ?? colors.text2,
        }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

export default UserSettingsDialog;
