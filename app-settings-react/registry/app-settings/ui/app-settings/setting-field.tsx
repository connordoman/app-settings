"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { settingLabel } from "@/registry/app-settings/lib/app-settings/grouping";
import {
  isEnforced,
  settingStatus,
  visibleOverride,
} from "@/registry/app-settings/lib/app-settings/values";
import type {
  ResolvedSetting,
  SettingStatus,
  SettingValue,
  ValueProblem,
} from "@/registry/app-settings/lib/app-settings/types";
import {
  useSetting,
  type UseSettingOptions,
} from "@/registry/app-settings/hooks/app-settings/use-setting";
import {
  SettingInput,
  type SettingInputComponent,
} from "@/registry/app-settings/ui/app-settings/setting-input";
import { SettingResetButton } from "@/registry/app-settings/ui/app-settings/setting-reset-button";
import {
  SettingOverrideBadge,
  SettingSourceBadge,
} from "@/registry/app-settings/ui/app-settings/setting-source-badge";

/**
 * One setting: its name, its description, its state and its control.
 *
 * `layout="auto"`, the default, puts a compact control — a switch, a select, a
 * number — on the same row as its label, and gives a long text or JSON value a
 * row of its own.
 */
export const settingFieldVariants = cva("group/setting-field w-full min-w-0", {
  variants: {
    layout: {
      stacked: "flex flex-col gap-2",
      inline: "flex flex-row flex-wrap items-center justify-between gap-x-6 gap-y-2",
    },
    size: {
      sm: "py-2 text-sm",
      default: "py-3",
      lg: "py-4",
    },
  },
  defaultVariants: { layout: "inline", size: "default" },
});

/** Which types read better with the control beneath the label. */
function autoLayout(setting: ResolvedSetting): "inline" | "stacked" {
  if (setting.type === "JSON") return "stacked";
  if (setting.type === "SELECT" && setting.type_config?.multiple) return "stacked";
  if (setting.type === "STRING") {
    const max = setting.type_config?.max_length;
    return max !== undefined && max > 120 ? "stacked" : "inline";
  }
  return "inline";
}

/** What every part of a field can read, so a custom one behaves like the rest. */
export interface SettingFieldContextValue {
  setting: ResolvedSetting;
  value: SettingValue;
  onValueChange: (value: SettingValue) => void;
  status: SettingStatus;
  disabled: boolean;
  /** A write is in flight, or an edit is unsaved. */
  pending: boolean;
  /** Edited locally and not yet saved, in draft mode. */
  dirty: boolean;
  problem: ValueProblem | null;
  /** Clears the stored value, when the field knows how to. */
  onReset?: () => void | Promise<unknown>;
  controlId: string;
  descriptionId: string;
}

const SettingFieldContext = React.createContext<SettingFieldContextValue | null>(null);

/** The field a part is rendering inside. */
export function useSettingFieldContext(): SettingFieldContextValue {
  const context = React.useContext(SettingFieldContext);
  if (!context) {
    throw new Error("Setting field parts must be rendered inside <SettingField>.");
  }
  return context;
}

type FieldChildren =
  | React.ReactNode
  | ((field: SettingFieldContextValue) => React.ReactNode);

export interface SettingFieldProps
  extends Omit<React.ComponentProps<"div">, "children">,
    Omit<VariantProps<typeof settingFieldVariants>, "layout"> {
  /**
   * Bind to a setting by name and let the field read and write it.
   *
   * Pass this for a switchboard. Pass `setting` / `value` / `onValueChange`
   * instead to drive the field from a `useSettingsDraft` form.
   */
  name?: string;
  /** Controlled mode: the resolved setting to render. */
  setting?: ResolvedSetting;
  /** Controlled mode: the value to show. */
  value?: SettingValue;
  /** Controlled mode: called when the control produces a new value. */
  onValueChange?: (value: SettingValue) => void;

  /** `auto` picks a layout from the setting's type. */
  layout?: "auto" | "stacked" | "inline";
  /** Overrides the label, which is otherwise derived from the setting's name. */
  label?: React.ReactNode;
  /** Overrides the description, which otherwise comes from the definition. */
  description?: React.ReactNode;
  /** Show the raw setting name beside the label. On by default. */
  showName?: boolean;
  /** Show the badge saying which layer the value came from. On by default. */
  showSource?: boolean;
  /** Show a button that clears the stored value. On in bound mode. */
  showReset?: boolean;
  /** Clears the stored value. Supplied automatically in bound mode. */
  onReset?: () => void | Promise<unknown>;
  /** Renders the field disabled whatever the transport allows. */
  disabled?: boolean;
  /** Draft mode: mark the row as edited but unsaved. */
  dirty?: boolean;
  /** Draft mode: the local validation failure to show under the control. */
  problem?: ValueProblem | null;
  /** Replaces the control for this field alone. */
  input?: SettingInputComponent;
  /** Forwarded to the control, for `placeholder`, `rows`, `commitOn` and such. */
  inputProps?: Record<string, unknown>;
  /** Bound mode: which layer to write, whose value to read, and so on. */
  settingOptions?: UseSettingOptions;
  /**
   * Replaces the whole right-hand side.
   *
   * A function receives the field's state, which is the escape hatch for a
   * control this library does not ship.
   */
  children?: FieldChildren;
}

/**
 * A labelled setting row.
 *
 * @example Bound to a resolution, writing on change:
 * <SettingField name="signups.enabled" />
 *
 * @example Driven by a draft form:
 * <SettingField {...draft.field("rate.limit")!} />
 *
 * @example With a control of your own:
 * <SettingField name="theme.accent">
 *   {({ value, onValueChange }) => <ColorPicker value={value} onChange={onValueChange} />}
 * </SettingField>
 */
export function SettingField(props: SettingFieldProps) {
  if (props.name !== undefined && props.setting === undefined) {
    const { name, ...rest } = props;
    return <BoundSettingField name={name} {...rest} />;
  }

  if (!props.setting) {
    throw new Error("<SettingField> needs either a `name` or a `setting`.");
  }

  return <SettingFieldBase {...props} setting={props.setting} />;
}

/** The bound half: one setting read and written through {@link useSetting}. */
function BoundSettingField({
  name,
  settingOptions,
  showReset = true,
  ...rest
}: Omit<SettingFieldProps, "name"> & { name: string }) {
  const { setting, value, isLoading, isWriting, problem, canWrite, set, clear, status } =
    useSetting(name, settingOptions);

  if (!setting) {
    return isLoading ? (
      <SettingFieldSkeleton className={rest.className} />
    ) : (
      <MissingSetting name={name} className={rest.className} />
    );
  }

  return (
    <SettingFieldBase
      {...rest}
      setting={setting}
      value={value}
      onValueChange={(next) => void set(next)}
      disabled={rest.disabled ?? !canWrite}
      pending={isWriting}
      problem={rest.problem ?? problem}
      showReset={showReset && canWrite}
      onReset={rest.onReset ?? clear}
      data-source={status?.source}
    />
  );
}

function SettingFieldBase({
  setting,
  value,
  onValueChange,
  layout = "auto",
  size,
  label,
  description,
  showName = true,
  showSource = true,
  showReset = false,
  onReset,
  disabled = false,
  dirty = false,
  pending,
  problem = null,
  input,
  inputProps,
  className,
  children,
  // Bound-mode leftovers that must not reach the DOM.
  name: _name,
  settingOptions: _settingOptions,
  ...props
}: SettingFieldProps & { setting: ResolvedSetting; pending?: boolean }) {
  const reactId = React.useId();
  const controlId = `setting-${reactId}`;
  const descriptionId = `${controlId}-description`;

  const status = settingStatus(setting);
  const enforced = isEnforced(setting);
  const override = visibleOverride(setting);
  const resolvedLayout = layout === "auto" ? autoLayout(setting) : layout;
  const text = description ?? setting.description;

  const context: SettingFieldContextValue = {
    setting,
    value: value ?? null,
    onValueChange: onValueChange ?? (() => {}),
    status,
    disabled: disabled || enforced,
    pending: pending === true || dirty,
    dirty,
    problem,
    onReset,
    controlId,
    descriptionId,
  };

  return (
    <SettingFieldContext.Provider value={context}>
      <div
        data-slot="setting-field"
        data-setting={setting.name}
        data-type={setting.type}
        data-source={status.source}
        data-layout={resolvedLayout}
        data-enforced={enforced || undefined}
        data-overridden={override ? true : undefined}
        data-dirty={dirty || undefined}
        data-invalid={problem ? true : undefined}
        className={cn(settingFieldVariants({ layout: resolvedLayout, size }), className)}
        {...props}
      >
        <SettingFieldHeader
          label={label}
          showName={showName}
          showSource={showSource}
          className={resolvedLayout === "inline" ? "min-w-0 flex-1" : undefined}
        >
          {text ? <SettingFieldDescription>{text}</SettingFieldDescription> : null}
        </SettingFieldHeader>

        <div
          data-slot="setting-field-action"
          className={cn(
            "flex items-center gap-2",
            resolvedLayout === "stacked" && "w-full",
          )}
        >
          {typeof children === "function" ? (
            children(context)
          ) : children !== undefined ? (
            children
          ) : (
            <SettingFieldControl as={input} {...inputProps} />
          )}

          {showReset && onReset ? (
            <SettingResetButton onReset={onReset} source={status.source} disabled={disabled} />
          ) : null}
        </div>

        {problem ? <SettingFieldMessage>{problem.message}</SettingFieldMessage> : null}
      </div>
    </SettingFieldContext.Provider>
  );
}

/** The label, the raw name and the state badges. */
export function SettingFieldHeader({
  label,
  showName = true,
  showSource = true,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  label?: React.ReactNode;
  showName?: boolean;
  showSource?: boolean;
}) {
  const { setting, status, controlId } = useSettingFieldContext();
  const override = visibleOverride(setting);

  return (
    <div
      data-slot="setting-field-header"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SettingFieldLabel htmlFor={controlId}>
          {label ?? settingLabel(setting)}
        </SettingFieldLabel>

        {showName && (
          <code
            data-slot="setting-field-name"
            className="text-muted-foreground bg-muted/60 rounded px-1 py-0.5 text-[0.7rem]"
          >
            {setting.name}
          </code>
        )}

        {showSource && <SettingSourceBadge source={status.source} />}
        {override && <SettingOverrideBadge override={override} />}
      </div>

      {children}
    </div>
  );
}

export function SettingFieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="setting-field-label"
      className={cn("text-sm leading-none font-medium", className)}
      {...props}
    />
  );
}

export function SettingFieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  const { descriptionId } = useSettingFieldContext();
  return (
    <p
      data-slot="setting-field-description"
      id={descriptionId}
      className={cn("text-muted-foreground max-w-prose text-sm", className)}
      {...props}
    />
  );
}

export function SettingFieldMessage({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="setting-field-message"
      role="alert"
      className={cn("text-destructive w-full text-xs", className)}
      {...props}
    />
  );
}

/** The control itself, wired to the field's state. */
export function SettingFieldControl({
  as,
  className,
  ...props
}: { as?: SettingInputComponent; className?: string } & Record<string, unknown>) {
  const field = useSettingFieldContext();

  return (
    <SettingInput
      as={as}
      setting={field.setting}
      value={field.value}
      onValueChange={field.onValueChange}
      disabled={field.disabled}
      pending={field.pending}
      id={field.controlId}
      aria-describedby={field.setting.description ? field.descriptionId : undefined}
      aria-invalid={field.problem ? true : undefined}
      className={className}
      {...props}
    />
  );
}

/** A field-shaped placeholder, for a resolution that has not arrived. */
export function SettingFieldSkeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-field-skeleton"
      className={cn("flex items-center justify-between gap-6 py-3", className)}
      {...props}
    >
      <div className="flex w-full max-w-sm flex-col gap-2">
        <div className="bg-muted h-4 w-40 animate-pulse rounded" />
        <div className="bg-muted h-3 w-full animate-pulse rounded" />
      </div>
      <div className="bg-muted h-8 w-24 animate-pulse rounded" />
    </div>
  );
}

function MissingSetting({ name, className }: { name: string; className?: string }) {
  return (
    <div
      data-slot="setting-field-missing"
      className={cn(
        "text-muted-foreground border-destructive/30 rounded-md border border-dashed px-3 py-2 text-sm",
        className,
      )}
    >
      <code className="font-mono text-xs">{name}</code> is not in this resolution — it may not
      exist, or this role may not be allowed to see it.
    </div>
  );
}
