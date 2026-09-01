import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "Conveyance",
    template: "%s · Conveyance",
  },
  description:
    "Escrow for a domain name that has to change hands. Conveyance reads the registry and the zone inside consensus, and releases the money only when both say the transfer the deal required actually happened.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className="cv-plate cv-body antialiased">
        <a href="#main" className="cv-skip cv-legend cv-legend-ink">
          skip to the record
        </a>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
