import type { ReactNode } from 'react';
import { Providers } from '@/ui/Providers';
import '@/ui/styles/globals.css';
import '@/ui/styles/components.css';
import { ThemeScript } from '@/ui/theme/ThemeScript';

export const metadata = { title: 'Subagents as a team', description: 'An operator console for Claude Code' };

export default function RootLayout({ children }: { children: ReactNode }) {
  // `suppressHydrationWarning` covers only these two elements' own attributes, which is where the
  // theme script (`data-theme`) and extensions such as Grammarly and ColorZilla write before React
  // hydrates; a mismatch anywhere below still surfaces. `darkreader-lock` is Dark Reader's opt-out
  // for sites with their own dark theme, so it leaves the icons it would otherwise restyle alone.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="darkreader-lock" />
        <ThemeScript />
      </head>
      <body suppressHydrationWarning>
        <Providers>
          <div className="app">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
