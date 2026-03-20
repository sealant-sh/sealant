import { z } from "zod";

import { emailString, passwordString, requiredString } from "@/lib/forms/zod";

export const registerFormSchema = z
  .object({
    confirmPassword: passwordString("Confirm password"),
    email: emailString(),
    name: requiredString("Name"),
    password: passwordString(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords must match before the account can be created.",
    path: ["confirmPassword"],
  });

export type RegisterFormValues = z.infer<typeof registerFormSchema>;

export const registerFormDefaults = {
  confirmPassword: "",
  email: "",
  name: "",
  password: "",
} satisfies RegisterFormValues;
