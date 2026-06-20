import { useRouter } from "expo-router";
import { BellRing, LogIn, RadioTower } from "lucide-react-native";

import { mobileDataMode } from "@/api/client";
import { ActionButton, DataModePill, Notice, PageHeader, Screen, Section } from "@/components/ui";
import { registerForRunStatusNotifications } from "@/lib/notifications";
import { colors } from "@/styles/theme";

export default function SettingsScreen() {
  const router = useRouter();

  return (
    <Screen>
      <PageHeader
        eyebrow="Settings"
        title="Runtime surfaces"
        summary="Local defaults are safe for demo work, while live mode can point at the existing control-plane API."
        trailing={<DataModePill mode={mobileDataMode} />}
      />

      <Section title="Data Source">
        <Notice
          title="Sandbox live mode"
          detail="Set EXPO_PUBLIC_SEALANT_MOBILE_DATA_SOURCE=live and EXPO_PUBLIC_SEALANT_API_BASE_URL=http://localhost:4000 to use live sandbox list/detail/attempt/event endpoints."
        />
        <Notice
          title="Issue workflow preview"
          detail="Issue workflows, approvals, and Run Records intentionally use mock adapters until mobile-facing HTTP endpoints exist."
        />
      </Section>

      <Section title="Auth">
        <Notice
          title="Better Auth path"
          detail="The first live auth lane should use Better Auth's Expo integration with SecureStore-backed cookies and the sealant:// scheme in trusted origins."
        />
        <ActionButton
          icon={<LogIn color={colors.text} size={16} />}
          label="Open sign in"
          onPress={() => router.push("/sign-in")}
        />
      </Section>

      <Section title="Notifications">
        <ActionButton
          icon={<BellRing color={colors.black} size={16} />}
          label="Register this device"
          onPress={() => {
            void registerForRunStatusNotifications();
          }}
          variant="primary"
        />
        <ActionButton
          icon={<RadioTower color={colors.text} size={16} />}
          label="Open approvals"
          onPress={() => router.push("/approvals")}
        />
      </Section>
    </Screen>
  );
}
