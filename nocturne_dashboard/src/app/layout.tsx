import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Providers from "./providers";

/**
 * The design leans on two faces and no more: a neutral grotesque for prose and
 * chrome, a monospace for every hash, score, IP, offset and timestamp. Both are
 * loaded as variable fonts and exposed as CSS variables so `theme/tokens.ts` can
 * reference them without importing anything client-side.
 */
const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  axes: ["opsz"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Nocturne Console",
  description: "Dark-web breach intelligence with verbatim evidence.",
};

export const viewport: Viewport = {
  themeColor: "#04070E",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body style={{ margin: 0 }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
