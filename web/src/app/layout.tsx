import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pulse · Fleet Telemetry",
  description: "Real-time IoT telemetry and alerting dashboard",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions add attributes to <html> before React hydrates
    // (e.g. data-send-extension-ready). This only silences attribute
    // mismatches on this one element, not on anything inside it.
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
