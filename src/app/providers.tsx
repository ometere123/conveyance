"use client";

import { TransactionProvider } from "@/components/transaction-provider";
import { WalletProvider } from "@/components/wallet-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <TransactionProvider>{children}</TransactionProvider>
    </WalletProvider>
  );
}
