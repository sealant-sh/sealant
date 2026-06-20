import * as SecureStore from "expo-secure-store";

const sessionKey = "sealant.mobile.session";

export interface StoredSession {
  readonly userId: string;
  readonly email: string;
  readonly createdAt: string;
}

export const sessionStore = {
  read: async (): Promise<StoredSession | null> => {
    const raw = await SecureStore.getItemAsync(sessionKey);

    if (raw === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "userId" in parsed &&
      "email" in parsed &&
      "createdAt" in parsed &&
      typeof parsed.userId === "string" &&
      typeof parsed.email === "string" &&
      typeof parsed.createdAt === "string"
    ) {
      return {
        userId: parsed.userId,
        email: parsed.email,
        createdAt: parsed.createdAt,
      };
    }

    return null;
  },
  writeDemoSession: async (email: string): Promise<StoredSession> => {
    const session = {
      userId: "user-demo",
      email,
      createdAt: new Date().toISOString(),
    };

    await SecureStore.setItemAsync(sessionKey, JSON.stringify(session));
    return session;
  },
  clear: async (): Promise<void> => {
    await SecureStore.deleteItemAsync(sessionKey);
  },
};
