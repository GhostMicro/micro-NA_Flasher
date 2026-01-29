import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NA Framework (Navigation Autonomous Framework) | นวัตกรรมหุ่นยนต์แห่งอนาคต",
  description: "ระบบติดตั้งเฟิร์มแวร์ NA Framework สำหรับ ESP32 ผ่านเว็บเบราว์เซอร์ด้วยความปลอดภัยสูงสุด",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th">
      <body className={`${inter.className} bg-slate-950 text-slate-50 antialiased`}>
        {children}
      </body>
    </html>
  );
}
