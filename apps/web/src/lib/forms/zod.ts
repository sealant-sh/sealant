import { z } from "zod";

export function requiredString(label: string) {
  return z.string().trim().min(1, `${label} is required.`);
}

export function optionalString() {
  return z.string();
}

export function emailString(label = "Email") {
  return requiredString(label).email("Enter a valid email address.");
}

export function passwordString(label = "Password", minLength = 8) {
  return requiredString(label).min(minLength, `${label} must be at least ${minLength} characters.`);
}

export function normalizeRequiredString(value: string) {
  return value.trim();
}

export function normalizeOptionalString(value: string) {
  const normalizedValue = value.trim();

  return normalizedValue.length > 0 ? normalizedValue : undefined;
}
