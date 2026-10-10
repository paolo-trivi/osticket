"use client";

import { useCallback, useRef, useState } from "react";

import type { ToastMessage } from "./BoardToast";

export type ShowToast = (msg: Omit<ToastMessage, "id">) => void;

/** Notifica corrente della board (una alla volta; l'id distingue due messaggi uguali consecutivi). */
export function useBoardToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const showToast = useCallback<ShowToast>(
    (msg) => setToast({ ...msg, id: ++toastId.current }),
    [],
  );
  const closeToast = useCallback(() => setToast(null), []);
  return { toast, showToast, closeToast };
}
