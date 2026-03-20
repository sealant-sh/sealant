import { z } from "zod";

import { emailString, requiredString } from "@/lib/forms/zod";

export const loginFormSchema = z.object({
  email: emailString(),
  password: requiredString("Password"),
});

export type LoginFormValues = z.infer<typeof loginFormSchema>;

export const loginFormDefaults = {
  email: "",
  password: "",
} satisfies LoginFormValues;
