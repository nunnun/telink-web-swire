import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const siteBase = process.env.GITHUB_PAGES === "true"
  ? "https://nunnun.github.io/telink-web-swire"
  : "https://telink-web-swire.hirotakanakajima.chatgpt.site";
const title = "Telink Web SWire — Browser flash tool";
const description = "Read, write, and byte-verify Telink TLSR826x SPI flash through a USB-UART adapter and Web Serial.";

export const metadata: Metadata = {
  metadataBase: new URL(siteBase),
  title,
  description,
  openGraph: { title, description, type: "website", images: [{ url: "/og.png", width: 1731, height: 909, alt: "Telink Web SWire — Read, Write, Verify" }] },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
