import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LineLight",
  description:
    "A private, dyslexia-friendly read-along space with synchronized highlighting.",
  applicationName: "LineLight",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "LineLight",
  },
  formatDetection: {
    telephone: false,
  },
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="manifest"
          href="/manifest.webmanifest"
          crossOrigin="use-credentials"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
