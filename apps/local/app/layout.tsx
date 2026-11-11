import type { Metadata } from "next";
import "./globals.css";
import RefreshOnFocus from "@/components/RefreshOnFocus";

export const metadata: Metadata = {
  title: "Kairos",
  description:
    "An authenticity-preserving career representation engine: your real experience, in its strongest honest form.",
};

// Set the theme before paint to avoid a flash. Defaults to dark when unset.
const themeScript = `(function(){try{var t=localStorage.getItem('kairos-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">
        <RefreshOnFocus />
        {children}
      </body>
    </html>
  );
}
