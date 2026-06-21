import { boolean, index, snakeCase, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Client-level `casing: "snake_case"` no longer exists, so re-apply snake_case at the
// table level to keep implicit column names mapping to snake_case db columns.
const pgTable = snakeCase.table;

export const user = pgTable(
  "user",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("user_email_idx").on(table.email)],
);

export const session = pgTable(
  "session",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text().notNull(),
    expiresAt: timestamp({ mode: "date", withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("session_token_idx").on(table.token),
    index("session_user_id_idx").on(table.userId),
    index("session_expires_at_idx").on(table.expiresAt),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    accessTokenExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    scope: text(),
    idToken: text(),
    password: text(),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("account_provider_account_idx").on(table.providerId, table.accountId),
    index("account_user_id_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("verification_identifier_value_idx").on(table.identifier, table.value),
    index("verification_expires_at_idx").on(table.expiresAt),
  ],
);

export type AuthUser = typeof user.$inferSelect;
export type NewAuthUser = typeof user.$inferInsert;

export type AuthSession = typeof session.$inferSelect;
export type NewAuthSession = typeof session.$inferInsert;

export type AuthAccount = typeof account.$inferSelect;
export type NewAuthAccount = typeof account.$inferInsert;

export type AuthVerification = typeof verification.$inferSelect;
export type NewAuthVerification = typeof verification.$inferInsert;
