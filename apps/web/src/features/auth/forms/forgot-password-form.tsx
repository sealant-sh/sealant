import { z } from "zod";

import { emailString } from "@/lib/forms/zod";

export const forgotPasswordFormSchema = z.object({
  email: emailString(),
});

export type ForgotPasswordFormValues = z.infer<typeof forgotPasswordFormSchema>;

export const forgotPasswordFormDefaults = {
  email: "",
} satisfies ForgotPasswordFormValues;
