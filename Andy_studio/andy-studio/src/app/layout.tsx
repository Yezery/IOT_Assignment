import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Andy Studio · AIoT Dashboard",
  description: "AIoT device dashboard for the Andy ESP32-S3.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}