import type { Metadata } from "next";
import { Instrument_Serif, Inter } from "next/font/google";
import "./globals.css";

const serif = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--serif", display: "swap" });
const sans = Inter({ subsets: ["latin"], variable: "--sans", display: "swap" });

export const metadata: Metadata = { title: "Trajectory", description: "drive Claude Code, watch the run" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
