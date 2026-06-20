import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import type { ReactNode } from "react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 24 * 60 * 60 * 1000,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "sealant-mobile-query-cache",
});

interface QueryProviderProps {
  readonly children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        buster: "sealant-mobile-v1",
        maxAge: 24 * 60 * 60 * 1000,
        persister,
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
