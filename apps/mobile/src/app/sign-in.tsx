import { useRouter } from "expo-router";
import { LogIn } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, TextInput } from "react-native";

import { ActionButton, Notice, PageHeader, Screen, Section } from "@/components/ui";
import { sessionStore } from "@/lib/session-store";
import { colors, radii, spacing, typography } from "@/styles/theme";

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("yiannis@example.com");

  return (
    <Screen>
      <PageHeader
        eyebrow="Sign In"
        title="Secure mobile access"
        summary="The first live lane should reuse Better Auth sessions with SecureStore-backed mobile cookies."
      />

      <Section title="Demo Session">
        <TextInput
          accessibilityLabel="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={colors.dim}
          style={styles.input}
          value={email}
        />
        <ActionButton
          icon={<LogIn color={colors.black} size={16} />}
          label="Continue"
          onPress={() => {
            void sessionStore.writeDemoSession(email).then(() => router.replace("/"));
          }}
          variant="primary"
        />
      </Section>

      <Notice
        title="Implementation note"
        detail="Do not ship this demo session path as production auth. Add @better-auth/expo on the server/client pair, trust sealant:// origins, and forward Better Auth cookies consistently for API calls."
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    ...typography.body,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
});
