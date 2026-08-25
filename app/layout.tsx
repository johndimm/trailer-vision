import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import NavBar from "./components/NavBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Trailer Vision",
  description: "Trailer-first taste calibration — find films you haven't seen but will love",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NavBar hubUrl={process.env.VITE_HUB_URL || "https://johndimm.vercel.app"} />
        {children}
        <footer className="w-full border-t border-zinc-800 py-4 text-center text-xs text-zinc-500">
          © 2026 John Dimm
        </footer>
        <Analytics />
      </body>
    </html>
  );
}
