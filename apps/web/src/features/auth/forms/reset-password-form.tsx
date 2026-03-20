import { z } from "zod";

import { passwordString } from "@/lib/forms/zod";

export const resetPasswordFormSchema = z
  .object({
    confirmPassword: passwordString("Confirm password"),
    password: passwordString("New password"),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "The new password and confirmation must match.",
    path: ["confirmPassword"],
  });

export type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;

export const resetPasswordFormDefaults = {
  confirmPassword: "",
  password: "",
} satisfies ResetPasswordFormValues;
