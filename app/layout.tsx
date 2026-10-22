import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "یارا · دستیار عملیات لیارا", template: "%s · یارا" },
  description: "یارا لاگ‌ها، استقرارها و مصرف منابع برنامه‌هایتان روی لیارا را می‌خواند، علت مشکل را پیدا می‌کند و هیچ تغییری را بدون مهر شما اعمال نمی‌کند.",
  applicationName: "Yara",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0c0e" },
  ],
};

// Applies the saved theme before first paint so there is no flash.
const themeScript = `try{var t=localStorage.getItem("yara-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preload" href="/fonts/YekanBakh-VF.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body>
        <Script id="yara-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
