"use client";

import { useEffect } from "react";

type Tone = "default" | "danger";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  tone = "default",
  showCancel = true,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  tone?: Tone;
  /** When false, only the confirm button is shown (alert-style). */
  showCancel?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const confirmBtn =
    tone === "danger"
      ? "rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
      : "rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800";

  const cancelBtn =
    "rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="bg-white border border-zinc-200 rounded-xl p-6 max-w-md w-full shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-black mb-2">
          {title}
        </h2>
        <div className="text-sm text-zinc-500">{children}</div>
        <div className="mt-6 flex justify-end gap-3">
          {showCancel && (
            <button type="button" className={cancelBtn} onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button type="button" className={confirmBtn} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
