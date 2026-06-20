import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { QueryProvider } from "@/providers/query-provider";
import { colors } from "@/styles/theme";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <QueryProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: colors.background },
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ title: "Sign in" }} />
          <Stack.Screen name="sandboxes/[sandboxId]/index" options={{ title: "Sandbox" }} />
          <Stack.Screen
            name="sandboxes/[sandboxId]/attempts"
            options={{ title: "Sandbox Attempts" }}
          />
          <Stack.Screen
            name="sandboxes/[sandboxId]/events"
            options={{ title: "Sandbox Timeline" }}
          />
          <Stack.Screen name="issues/[issueId]/index" options={{ title: "Issue" }} />
          <Stack.Screen name="workflows/[workflowId]/index" options={{ title: "Workflow" }} />
          <Stack.Screen name="approvals/[approvalId]/index" options={{ title: "Approval" }} />
          <Stack.Screen name="run-records/[recordId]/index" options={{ title: "Run Record" }} />
        </Stack>
      </QueryProvider>
    </GestureHandlerRootView>
  );
}
