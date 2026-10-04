"use client";
import Link from "next/link";
import { useEffect } from "react";

export default function TopBar({ right }: { right?: React.ReactNode }) {
  // In the desktop shell the traffic lights sit over the page, so the bar has to make room
  // for them — and doubles as the window's drag handle.
  useEffect(() => {
    if (typeof window !== "undefined" && window.trajectory?.desktop) {
      document.documentElement.dataset.desktop = "1";
    }
  }, []);

  return (
    <div className="top">
      <Link href="/" className="brand">Trajectory</Link>
      <span className="spacer" />
      {right}
    </div>
  );
}
