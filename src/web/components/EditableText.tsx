import { useState } from "react";
import type { KeyboardEvent } from "react";

interface EditableTextProps {
    value: string;
    onCommit: (value: string) => void;
    label: string;
    className?: string;
    multiline?: boolean;
    rows?: number;
    /** Commit on a plain Enter even in a textarea; for fields that wrap but are one line of text. */
    submitOnEnter?: boolean;
    placeholder?: string;
    allowEmpty?: boolean;
}

/**
 * Shows the live model value until focused, then edits a local draft and commits it on
 * blur or Enter. Remote changes never yank text out from under the cursor, and one edit
 * becomes one transaction instead of one per keystroke.
 */
export function EditableText({ value, onCommit, label, className, multiline = false, rows = 6, submitOnEnter = !multiline, placeholder, allowEmpty = false }: EditableTextProps) {
    const [draft, setDraft] = useState<string | null>(null);

    function commit() {
        if (draft !== null && draft !== value && (allowEmpty || draft.trim())) onCommit(draft);
        setDraft(null);
    }

    function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
        if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
        } else if (event.key === "Enter" && (submitOnEnter || event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.blur();
        }
    }

    const props = {
        "aria-label": label,
        className,
        placeholder,
        value: draft ?? value,
        onFocus: () => setDraft(value),
        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown,
    };
    return multiline ? <textarea {...props} rows={rows} /> : <input {...props} />;
}
