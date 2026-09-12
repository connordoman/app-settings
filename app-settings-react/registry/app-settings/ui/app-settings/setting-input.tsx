"use client";

import * as React from "react";

import type {
  SettingInputProps,
  SettingType,
  SettingValue,
} from "@/registry/app-settings/lib/app-settings/types";
import { SettingDateTimeInput } from "@/registry/app-settings/ui/app-settings/setting-datetime-input";
import { SettingJsonInput } from "@/registry/app-settings/ui/app-settings/setting-json-input";
import { SettingNumberInput } from "@/registry/app-settings/ui/app-settings/setting-number-input";
import { SettingSelect } from "@/registry/app-settings/ui/app-settings/setting-select";
import { SettingSwitch } from "@/registry/app-settings/ui/app-settings/setting-switch";
import { SettingTextInput } from "@/registry/app-settings/ui/app-settings/setting-text-input";

/** Any control that can render one setting's value. */
export type SettingInputComponent = React.ComponentType<SettingInputProps<SettingValue>>;

/**
 * The default control for each setting type.
 *
 * The casts are where the mapping is asserted: a `BOOLEAN` value is only ever
 * handed to the switch, so the switch is free to say it takes a boolean.
 */
export const settingInputs: Record<SettingType, SettingInputComponent> = {
  BOOLEAN: SettingSwitch as unknown as SettingInputComponent,
  NUMBER: SettingNumberInput as unknown as SettingInputComponent,
  STRING: SettingTextInput as unknown as SettingInputComponent,
  DATETIME: SettingDateTimeInput as unknown as SettingInputComponent,
  SELECT: SettingSelect as unknown as SettingInputComponent,
  JSON: SettingJsonInput as unknown as SettingInputComponent,
};

/** A partial override of the defaults, by setting type. */
export type SettingInputOverrides = Partial<Record<SettingType, SettingInputComponent>>;

const SettingInputsContext = React.createContext<SettingInputOverrides>({});

/**
 * Swaps the control used for one or more types, for everything below it.
 *
 * @example A slider for every bounded number on the page:
 * <SettingInputsProvider inputs={{ NUMBER: BoundedSlider }}>
 *   <SettingList />
 * </SettingInputsProvider>
 */
export function SettingInputsProvider({
  inputs,
  children,
}: {
  inputs: SettingInputOverrides;
  children?: React.ReactNode;
}) {
  const inherited = React.useContext(SettingInputsContext);
  const merged = React.useMemo(() => ({ ...inherited, ...inputs }), [inherited, inputs]);
  return <SettingInputsContext.Provider value={merged}>{children}</SettingInputsContext.Provider>;
}

/** The control registered for a type, honouring any provider above. */
export function useSettingInput(type: SettingType): SettingInputComponent {
  const overrides = React.useContext(SettingInputsContext);
  return overrides[type] ?? settingInputs[type];
}

export interface SettingInputDispatchProps extends SettingInputProps<SettingValue> {
  /** Overrides the control for this field alone. */
  as?: SettingInputComponent;
}

/**
 * Renders the right control for a setting's declared type.
 *
 * This is the seam: pass `as` for one field, wrap a subtree in
 * `<SettingInputsProvider>` for a page, or edit `settingInputs` for the whole
 * app — the file is yours once it is installed.
 */
export function SettingInput({ as, ...props }: SettingInputDispatchProps) {
  const Registered = useSettingInput(props.setting.type);
  const Control = as ?? Registered;
  return <Control {...props} />;
}
