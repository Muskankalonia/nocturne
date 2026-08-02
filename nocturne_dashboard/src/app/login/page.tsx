"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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
import { colors, fonts, layout } from "@/theme/tokens";

export default function LoginPage() {
  const router = useRouter();
  const { login, isAuthenticated, isLoading, isSuperAdmin } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace(isSuperAdmin ? "/admin/fleet" : "/");
    }
  }, [isLoading, isAuthenticated, isSuperAdmin, router]);

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
    router.replace(result.user.role === "SUPER_ADMIN" ? "/admin/fleet" : "/");
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
        justifyContent="space-between"
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
          <Stack direction="row" alignItems="center" gap={1.2}>
            <Box
              sx={{
                width: 22,
                height: 22,
                border: `1.5px solid ${colors.ion}`,
                borderRadius: "4px",
                boxShadow: `0 0 14px ${alpha(colors.ion, 0.45)}`,
                position: "relative",
                "&::after": {
                  content: '""',
                  position: "absolute",
                  inset: 5,
                  background: colors.ion,
                  borderRadius: "1px",
                },
              }}
            />
            <Typography sx={{ fontWeight: 600, fontSize: 14, letterSpacing: "0.02em" }}>
              NOCTURNE{" "}
              <Box component="span" sx={{ color: colors.text3, fontWeight: 400 }}>
                / console
              </Box>
            </Typography>
          </Stack>

          <Box sx={{ py: { xs: 5, md: 7 } }}>
            <Typography
              variant="h1"
              sx={{
                fontSize: "clamp(26px, 3.4vw, 44px)",
                lineHeight: 1.14,
                maxWidth: "17ch",
                textWrap: "balance",
              }}
            >
              Every alert carries{" "}
              <Box component="span" sx={{ color: colors.ion }}>
                the sentence that produced it
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
              Dark-web breach intelligence with verbatim evidence, deterministic ownership
              resolution, and a cost cascade that sends only 6.7% of pages to an expensive model.
            </Typography>
          </Box>

          <Stack direction="row" gap={{ xs: 3.5, md: 5 }} flexWrap="wrap">
            {[
              { n: "94.2%", l: "Grounded", c: colors.verified },
              { n: "6.7%", l: "To expensive AI", c: colors.ion },
              { n: "5", l: "Layers", c: colors.text1 },
            ].map((s) => (
              <Box key={s.l}>
                <Typography sx={{ fontFamily: fonts.mono, fontSize: 21, fontWeight: 600, color: s.c }}>
                  {s.n}
                </Typography>
                <Typography
                  sx={{
                    fontFamily: fonts.mono,
                    fontSize: 9.5,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: colors.text3,
                  }}
                >
                  {s.l}
                </Typography>
              </Box>
            ))}
          </Stack>
        </Stack>

      {/* form */}
      <Stack
        component="form"
        onSubmit={handleSubmit}
        justifyContent="center"
        gap={2}
        sx={{
          flex: { md: 1 },
          p: { xs: 3.5, sm: 5, md: 7, lg: 9 },
          // Keep the field column readable on ultra-wide displays instead of
          // letting inputs stretch across half a 4K screen.
          "& > *": { width: "100%", maxWidth: 520 },
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
              placeholder="palo_alto_networks"
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

          <Box
            sx={{
              mt: 0.5,
              p: 1.5,
              borderRadius: `${layout.radiusSm}px`,
              border: `1px dashed ${colors.edgeHi}`,
              fontSize: 11,
              color: colors.text2,
              lineHeight: 1.7,
            }}
          >
            <Box component="span" sx={{ color: colors.text1, fontWeight: 600 }}>
              Demo credentials
            </Box>
            <br />
            Tenant → <Code>palo_alto_networks</Code> / <Code>palo_alto_networks</Code>
            <br />
            Tenant → <Code>att</Code> / <Code>att</Code>
            <br />
            Fleet&nbsp;&nbsp;→ <Code>admin</Code> / <Code>admin</Code>
            <Box sx={{ mt: 1, pt: 1, borderTop: `1px solid ${colors.edge}` }}>
              <Box component="span" sx={{ color: colors.medium }}>
                ⚠ Demo scheme only.
              </Box>{" "}
              Tenant isolation is enforced server-side on the session, never by the client
              sending an organization id.
            </Box>
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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <Box component="code" sx={{ fontFamily: fonts.mono, color: colors.ion }}>
      {children}
    </Box>
  );
}
