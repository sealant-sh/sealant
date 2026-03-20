import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import * as React from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type SelectFieldOption = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
};

type FieldMessage = { message?: string };

type SharedFieldProps = {
  label?: React.ReactNode;
  description?: React.ReactNode;
  fieldClassName?: string;
  contentClassName?: string;
  labelClassName?: string;
  descriptionClassName?: string;
  errorClassName?: string;
};

type TextFieldProps = SharedFieldProps &
  Omit<
    React.ComponentProps<typeof Input>,
    "name" | "value" | "onChange" | "onBlur" | "aria-invalid"
  > & {
    inputClassName?: string;
  };

type PasswordFieldProps = SharedFieldProps &
  Omit<
    React.ComponentProps<typeof Input>,
    "name" | "value" | "onChange" | "onBlur" | "type" | "aria-invalid"
  > & {
    inputClassName?: string;
  };

type TextareaFieldProps = SharedFieldProps &
  Omit<
    React.ComponentProps<typeof Textarea>,
    "name" | "value" | "onChange" | "onBlur" | "aria-invalid"
  > & {
    textareaClassName?: string;
  };

type SelectFieldProps = SharedFieldProps & {
  placeholder?: React.ReactNode;
  options: ReadonlyArray<SelectFieldOption>;
  triggerClassName?: string;
  popupClassName?: string;
  disabled?: boolean;
  required?: boolean;
};

type ToggleFieldProps = SharedFieldProps & {
  id?: string;
  disabled?: boolean;
  required?: boolean;
  controlClassName?: string;
};

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

export function normalizeFieldErrors(errors: readonly unknown[] | undefined): Array<FieldMessage> {
  const messages = [
    ...new Set((errors ?? []).flatMap((error) => extractMessages(error)).filter(Boolean)),
  ];

  return messages.map((message) => ({ message }));
}

function extractMessages(error: unknown): Array<string> {
  if (error == null) {
    return [];
  }

  if (typeof error === "string") {
    return [error];
  }

  if (Array.isArray(error)) {
    return error.flatMap((item) => extractMessages(item));
  }

  if (typeof error === "object") {
    if ("message" in error && typeof error.message === "string") {
      return [error.message];
    }

    if ("errors" in error && Array.isArray(error.errors)) {
      return error.errors.flatMap((item) => extractMessages(item));
    }
  }

  return [];
}

function getTextValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function FieldMessages({
  description,
  descriptionClassName,
  errorClassName,
  errors,
}: Pick<SharedFieldProps, "description" | "descriptionClassName" | "errorClassName"> & {
  errors: Array<FieldMessage>;
}) {
  return (
    <>
      {description ? (
        <FieldDescription className={cn("text-sm text-muted-foreground", descriptionClassName)}>
          {description}
        </FieldDescription>
      ) : null}
      <FieldError className={cn("text-sm text-destructive", errorClassName)} errors={errors} />
    </>
  );
}

function TextField({
  label,
  description,
  fieldClassName,
  contentClassName,
  labelClassName,
  descriptionClassName,
  errorClassName,
  inputClassName,
  id,
  className,
  ...props
}: TextFieldProps) {
  const field = useFieldContext<string | null | undefined>();
  const errors = normalizeFieldErrors(field.state.meta.errors);
  const isInvalid = errors.length > 0;
  const inputId = id ?? field.name;

  return (
    <Field className={cn("space-y-2", fieldClassName)} data-invalid={isInvalid || undefined}>
      {label ? (
        <FieldLabel
          className={cn("text-sm font-medium text-foreground", labelClassName)}
          htmlFor={inputId}
        >
          {label}
        </FieldLabel>
      ) : null}
      <FieldContent className={cn("gap-1.5", contentClassName)}>
        <Input
          {...props}
          aria-invalid={isInvalid || undefined}
          className={cn(inputClassName, className)}
          id={inputId}
          name={field.name}
          onBlur={field.handleBlur}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            field.handleChange(event.target.value)
          }
          value={getTextValue(field.state.value)}
        />
        <FieldMessages
          description={description}
          descriptionClassName={descriptionClassName}
          errorClassName={errorClassName}
          errors={errors}
        />
      </FieldContent>
    </Field>
  );
}

function PasswordField(props: PasswordFieldProps) {
  return <TextField {...props} type="password" />;
}

function TextareaField({
  label,
  description,
  fieldClassName,
  contentClassName,
  labelClassName,
  descriptionClassName,
  errorClassName,
  textareaClassName,
  id,
  className,
  ...props
}: TextareaFieldProps) {
  const field = useFieldContext<string | null | undefined>();
  const errors = normalizeFieldErrors(field.state.meta.errors);
  const isInvalid = errors.length > 0;
  const inputId = id ?? field.name;

  return (
    <Field className={cn("space-y-2", fieldClassName)} data-invalid={isInvalid || undefined}>
      {label ? (
        <FieldLabel
          className={cn("text-sm font-medium text-foreground", labelClassName)}
          htmlFor={inputId}
        >
          {label}
        </FieldLabel>
      ) : null}
      <FieldContent className={cn("gap-1.5", contentClassName)}>
        <Textarea
          {...props}
          aria-invalid={isInvalid || undefined}
          className={cn(textareaClassName, className)}
          id={inputId}
          name={field.name}
          onBlur={field.handleBlur}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
            field.handleChange(event.target.value)
          }
          value={getTextValue(field.state.value)}
        />
        <FieldMessages
          description={description}
          descriptionClassName={descriptionClassName}
          errorClassName={errorClassName}
          errors={errors}
        />
      </FieldContent>
    </Field>
  );
}

function SelectField({
  label,
  description,
  fieldClassName,
  contentClassName,
  labelClassName,
  descriptionClassName,
  errorClassName,
  triggerClassName,
  popupClassName,
  placeholder,
  options,
  disabled,
  required,
}: SelectFieldProps) {
  const field = useFieldContext<string | null | undefined>();
  const errors = normalizeFieldErrors(field.state.meta.errors);
  const isInvalid = errors.length > 0;
  const inputId = field.name;

  return (
    <Field className={cn("space-y-2", fieldClassName)} data-invalid={isInvalid || undefined}>
      {label ? (
        <FieldLabel
          className={cn("text-sm font-medium text-foreground", labelClassName)}
          htmlFor={inputId}
        >
          {label}
        </FieldLabel>
      ) : null}
      <FieldContent className={cn("gap-1.5", contentClassName)}>
        <Select
          disabled={disabled}
          id={inputId}
          name={field.name}
          onValueChange={(value: string | null) => field.handleChange(value ?? "")}
          required={required}
          value={getTextValue(field.state.value) || null}
        >
          <SelectTrigger
            aria-invalid={isInvalid || undefined}
            className={triggerClassName}
            id={inputId}
            onBlur={field.handleBlur}
          >
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent className={popupClassName}>
            {options.map((option) => (
              <SelectItem disabled={option.disabled} key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldMessages
          description={description}
          descriptionClassName={descriptionClassName}
          errorClassName={errorClassName}
          errors={errors}
        />
      </FieldContent>
    </Field>
  );
}

function CheckboxField({
  label,
  description,
  fieldClassName,
  contentClassName,
  labelClassName,
  descriptionClassName,
  errorClassName,
  controlClassName,
  id,
  disabled,
  required,
}: ToggleFieldProps) {
  const field = useFieldContext<boolean>();
  const errors = normalizeFieldErrors(field.state.meta.errors);
  const isInvalid = errors.length > 0;
  const inputId = id ?? field.name;

  return (
    <Field
      className={cn("space-y-2", fieldClassName)}
      data-invalid={isInvalid || undefined}
      orientation="horizontal"
    >
      <Checkbox
        aria-invalid={isInvalid || undefined}
        checked={Boolean(field.state.value)}
        className={controlClassName}
        disabled={disabled}
        id={inputId}
        name={field.name}
        onBlur={field.handleBlur}
        onCheckedChange={(checked: boolean) => field.handleChange(checked)}
        required={required}
      />
      <FieldContent className={cn("gap-1.5", contentClassName)}>
        {label ? (
          <FieldLabel
            className={cn("text-sm font-medium text-foreground", labelClassName)}
            htmlFor={inputId}
          >
            {label}
          </FieldLabel>
        ) : null}
        <FieldMessages
          description={description}
          descriptionClassName={descriptionClassName}
          errorClassName={errorClassName}
          errors={errors}
        />
      </FieldContent>
    </Field>
  );
}

function SwitchField({
  label,
  description,
  fieldClassName,
  contentClassName,
  labelClassName,
  descriptionClassName,
  errorClassName,
  controlClassName,
  id,
  disabled,
  required,
}: ToggleFieldProps) {
  const field = useFieldContext<boolean>();
  const errors = normalizeFieldErrors(field.state.meta.errors);
  const isInvalid = errors.length > 0;
  const inputId = id ?? field.name;

  return (
    <Field
      className={cn("space-y-2", fieldClassName)}
      data-invalid={isInvalid || undefined}
      orientation="horizontal"
    >
      <Switch
        aria-invalid={isInvalid || undefined}
        checked={Boolean(field.state.value)}
        className={controlClassName}
        disabled={disabled}
        id={inputId}
        name={field.name}
        onBlur={field.handleBlur}
        onCheckedChange={(checked: boolean) => field.handleChange(checked)}
        required={required}
      />
      <FieldContent className={cn("gap-1.5", contentClassName)}>
        {label ? (
          <FieldLabel
            className={cn("text-sm font-medium text-foreground", labelClassName)}
            htmlFor={inputId}
          >
            {label}
          </FieldLabel>
        ) : null}
        <FieldMessages
          description={description}
          descriptionClassName={descriptionClassName}
          errorClassName={errorClassName}
          errors={errors}
        />
      </FieldContent>
    </Field>
  );
}

const { useAppForm } = createFormHook({
  fieldComponents: {
    CheckboxField,
    PasswordField,
    SelectField,
    SwitchField,
    TextareaField,
    TextField,
  },
  fieldContext,
  formComponents: {},
  formContext,
});

export {
  CheckboxField,
  createFormHook,
  createFormHookContexts,
  fieldContext,
  formContext,
  PasswordField,
  SelectField,
  SwitchField,
  TextareaField,
  TextField,
  useAppForm,
  useFieldContext,
  useFormContext,
};
