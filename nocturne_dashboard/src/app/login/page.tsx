"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import NextLink from "next/link";
import {
  Alert,
  Box,
  Button,
  InputAdornment,
  Stack,
  TextField,
  Typography,
  alpha,
} from "@mui/material";
import { Building2, Lock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { colors, fonts, gradients, layout, shadows } from "@/theme/tokens";

/**
 * Lockup size, shared by the mark itself and by the spacer that balances it.
 * The lockup is pinned to the top of the poster, so centring the headline in
 * the leftover space would sit it half a lockup below true centre and out of
 * line with the sign-in card. Reserving the same height at the bottom puts it
 * back on the panel's midline, and keeping one constant means the two can't
 * drift apart.
 *
 * Written as explicit pixel strings: `width` takes raw pixels but `mb` is on
 * MUI's 8px spacing scale, and a bare number would silently mean two different
 * things in the two places this is used.
 */
const LOCKUP_SIZE = { xs: "30px", md: "40px" };

export default function LoginPage() {
  const router = useRouter();
  const { login, isAuthenticated, isLoading } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/command-center");
    }
  }, [isLoading, isAuthenticated, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await login(username, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.replace("/command-center");
  }

  return (
    <Stack
      direction={{ xs: "column", md: "row" }}
      sx={{
        minHeight: "100dvh",
        width: "100%",
        backgroundColor: colors.void,
      }}
    >
      {/* poster */}
      <Stack
        sx={{
          flex: { md: 1.15 },
          p: { xs: 3.5, sm: 5, md: 7, lg: 10 },
          borderRight: { md: `1px solid ${colors.edge}` },
          borderBottom: { xs: `1px solid ${colors.edge}`, md: "none" },
          backgroundImage: [
            `radial-gradient(700px 520px at 18% 18%, ${alpha(colors.ion, 0.1)}, transparent 65%)`,
            `radial-gradient(620px 500px at 82% 88%, ${alpha(colors.critical, 0.08)}, transparent 65%)`,
          ].join(","),
        }}
      >
          {/* The poster is a hero, not chrome, so the lockup is sized against
            * the headline beneath it rather than against the nav rail. What
            * carries across is the *ratio*: 40/28 here and 24/17 in the rail
            * are both ~1.43, so it reads as one logo at two scales instead of
            * two different logos. */}
          {/* The lockup is the way back out. / is the public front door and
            * this is the only screen reachable from it that has no other exit,
            * so the mark carries the link rather than adding a stray "back". */}
          <Stack
            component={NextLink}
            href="/"
            direction="row"
            alignItems="center"
            gap={{ xs: 1.4, md: 1.8 }}
            sx={{ textDecoration: "none", color: colors.text1, alignSelf: "flex-start" }}
          >
            <Box
              component="img"
              src="/nocturne-mark.png"
              alt="Nocturne"
              width={40}
              height={40}
              sx={{
                display: "block",
                width: LOCKUP_SIZE,
                height: LOCKUP_SIZE,
                filter: `drop-shadow(0 0 16px ${alpha(colors.ion, 0.45)})`,
              }}
            />
            <Typography
              sx={{
                fontWeight: 700,
                fontSize: { xs: 21, md: 28 },
                letterSpacing: "0.06em",
                lineHeight: 1,
              }}
            >
              NOCTURNE
            </Typography>
          </Stack>

          {/* The lockup stays pinned to the top and the headline centres in
            * what's left, offset by a lockup's height so it lands on the
            * panel's true midline. Centring here rather than distributing the
            * column keeps the composition stable no matter how many blocks the
            * poster carries. */}
          <Box
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              py: { xs: 5, md: 7 },
              mb: LOCKUP_SIZE,
            }}
          >
            <Typography
              variant="h1"
              sx={{
                fontSize: "clamp(26px, 3.4vw, 44px)",
                lineHeight: 1.14,
                maxWidth: "15ch",
                textWrap: "balance",
              }}
            >
              Every breach alert comes with{" "}
              <Box component="span" sx={{ color: colors.ion }}>
                the receipt
              </Box>
              .
            </Typography>
            <Typography
              sx={{
                mt: 2.2,
                color: colors.text2,
                fontSize: { xs: 13, lg: 14.5 },
                lineHeight: 1.7,
                maxWidth: "46ch",
              }}
            >
              Most dark-web monitoring hands you a pile of maybes and leaves the verification to you. 
              Nocturne crawls the same sources, then refuses to call anything a breach until the 
              evidence connects to your organization and shows you the verbatim line that proves it.
            </Typography>
          </Box>
        </Stack>

      {/* form */}
      <Stack
        component="form"
        onSubmit={handleSubmit}
        justifyContent="center"
        gap={2}
        alignItems="center"
        sx={{
          flex: { md: 1 },
          p: { xs: 3, sm: 4, md: 6 },
          // The form is a defined surface rather than fields floating on the
          // page — an auth screen should look like a door, not a gap.
          "& > *": { width: "100%", maxWidth: 400 },
          backgroundImage: `radial-gradient(680px 520px at 60% 40%, ${alpha(colors.ion, 0.05)}, transparent 70%)`,
        }}
      >
        <Box
          sx={{
            width: "100%",
            maxWidth: 400,
            px: { xs: 2.5, sm: 3.5 },
            py: { xs: 3.5, sm: 5 },
            borderRadius: `${layout.radius}px`,
            border: `1px solid ${colors.edge}`,
            backgroundImage: gradients.panel,
            backdropFilter: "blur(20px)",
            boxShadow: shadows.raised,
            display: "flex",
            flexDirection: "column",
            gap: { xs: 2.5, sm: 3 },
          }}
        >
          <Box>
            <Typography variant="h3">Sign in</Typography>
            <Typography sx={{ fontSize: 12.5, color: colors.text3, mt: 0.4 }}>
              Use your organization identifier
            </Typography>
          </Box>

          {error && (
            <Alert
              severity="error"
              sx={{
                fontSize: 12,
                backgroundColor: alpha(colors.critical, 0.1),
                border: `1px solid ${alpha(colors.critical, 0.3)}`,
                color: colors.text1,
              }}
            >
              {error}
            </Alert>
          )}

          {/* Labels sit above the field rather than in the outline notch: the
              uppercase mono label is the console's own idiom, and a notch
              breaks the unbroken field border the design relies on. */}
          <Box>
            <FieldLabel htmlFor="login-org">Organization / username</FieldLabel>
            <TextField
              id="login-org"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              fullWidth
              // A real tenant id here would be a working credential on its own:
              // the demo scheme accepts the organization id as its own password.
              placeholder="organization id"
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Building2 size={15} color={colors.ion} />
                  </InputAdornment>
                ),
              }}
            />
          </Box>

          <Box>
            <FieldLabel htmlFor="login-password">Password</FieldLabel>
            <TextField
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              fullWidth
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Lock size={15} color={colors.text3} />
                  </InputAdornment>
                ),
              }}
            />
          </Box>

          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={submitting}
            fullWidth
            sx={{ py: 1.5, fontSize: 14 }}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </Button>

        </Box>
      </Stack>
    </Stack>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <Typography
      component="label"
      htmlFor={htmlFor}
      sx={{
        display: "block",
        mb: 0.9,
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: "0.13em",
        textTransform: "uppercase",
        color: colors.text3,
      }}
    >
      {children}
    </Typography>
  );
}
