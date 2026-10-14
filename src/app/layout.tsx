import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import "./globals.css";

// UI: a geometric sans with a generous x-height. Data (System page, code): a clear mono.
const ui = Outfit({ variable: "--font-ui", subsets: ["latin"], display: "swap" });
const code = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Telestorage", template: "%s · Telestorage" },
  description: "Cloud storage on your own private Telegram channel",
  applicationName: "Telestorage",
  appleWebApp: { capable: true, title: "Telestorage", statusBarStyle: "default" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#efeae1" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0e0e" },
  ],
};

/** Resolves the theme before first paint so there is never a light/dark flash. */
const themeBoot = `(function(){try{var p=(JSON.parse(localStorage.getItem('ts-prefs')||'{}').state||{}).theme||'system';var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${ui.variable} ${code.variable}`} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
