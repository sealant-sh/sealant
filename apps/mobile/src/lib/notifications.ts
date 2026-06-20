import * as Notifications from "expo-notifications";

export interface PushRegistration {
  readonly status: "registered" | "denied" | "unavailable";
  readonly token?: string;
}

export const registerForRunStatusNotifications = async (): Promise<PushRegistration> => {
  const permission = await Notifications.requestPermissionsAsync();

  if (!permission.granted) {
    return { status: "denied" };
  }

  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return {
      status: "registered",
      token: token.data,
    };
  } catch {
    return { status: "unavailable" };
  }
};

export const scheduleRunStatusPreview = async (): Promise<void> => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Issue workflow needs approval",
      body: "Network escalation is waiting for review.",
      data: {
        path: "/approvals/approval-network-314",
      },
    },
    trigger: null,
  });
};
