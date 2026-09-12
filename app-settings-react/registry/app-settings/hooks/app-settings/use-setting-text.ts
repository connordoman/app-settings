"use client";

/**
 * The editing behaviour every text-shaped input needs.
 *
 * A number, string, date-time or JSON control cannot report every keystroke:
 * with `useSetting` that would be one request per character, and with a draft it
 * would mean validating half-typed input. So the text is held locally and
 * committed on blur or Enter, with Escape putting it back.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import type { ValueProblem } from "@/registry/app-settings/lib/app-settings/types";

export interface UseSettingTextOptions<T> {
  /** The committed value, from the resolution or the draft. */
  value: T;
  /** Renders the committed value as editable text. */
  format: (value: T) => string;
  /** Reads the text back. Return a problem to block the commit. */
  parse: (text: string) => { ok: true; value: T } | { ok: false; problem: ValueProblem };
  onValueChange: (value: T) => void;
  /**
   * When to report a change.
   *
   * `blur` — the default — commits when the field loses focus or Enter is
   * pressed, which is what a per-keystroke write would otherwise cost.
   * `change` commits on every keystroke, for a draft form that is saved later.
   */
  commitOn?: "blur" | "change";
  /**
   * Whether Enter commits. True by default; a textarea passes false so Enter
   * inserts a newline instead.
   */
  commitOnEnter?: boolean;
}

export interface UseSettingTextResult {
  /** What the input should display. */
  text: string;
  /** Why the current text cannot be committed. */
  problem: ValueProblem | null;
  /** The text differs from the committed value. */
  dirty: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Commits the current text by hand, for a Save button inside the field. */
  commit: () => boolean;
  /** Throws the edit away and shows the committed value again. */
  revert: () => void;
}

export function useSettingText<T>({
  value,
  format,
  parse,
  onValueChange,
  commitOn = "blur",
  commitOnEnter = true,
}: UseSettingTextOptions<T>): UseSettingTextResult {
  const formatted = format(value);
  const [text, setText] = useState(formatted);
  const [problem, setProblem] = useState<ValueProblem | null>(null);
  const editing = useRef(false);

  // Follow the committed value, but never yank the text out from under someone
  // who is mid-edit — that is how a background refetch eats a keystroke.
  useEffect(() => {
    if (!editing.current) {
      setText(formatted);
      setProblem(null);
    }
  }, [formatted]);

  const commitText = useCallback(
    (candidate: string) => {
      const parsed = parse(candidate);
      if (!parsed.ok) {
        setProblem(parsed.problem);
        return false;
      }
      setProblem(null);
      if (format(parsed.value) !== formatted) onValueChange(parsed.value);
      return true;
    },
    [parse, format, formatted, onValueChange],
  );

  return {
    text,
    problem,
    dirty: text !== formatted,

    onChange: (event) => {
      setText(event.target.value);
      if (commitOn === "change") commitText(event.target.value);
    },

    onFocus: () => {
      editing.current = true;
    },

    onBlur: () => {
      editing.current = false;
      commitText(text);
    },

    onKeyDown: (event) => {
      if (event.key === "Enter" && commitOnEnter) {
        // Blurring is what commits, so a keyboard commit and a click-away
        // commit take exactly the same path.
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setText(formatted);
        setProblem(null);
      }
    },

    commit: () => commitText(text),

    revert: () => {
      setText(formatted);
      setProblem(null);
    },
  };
}
