import { create } from "zustand";

export type ToastVariant = "default" | "destructive" | "success";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastStore {
  toasts: Toast[];
  show: (message: string, variant?: ToastVariant, duration?: number) => void;
  dismiss: (id: string) => void;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `toast-${Date.now()}-${counter}`;
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  show: (message, variant = "default", duration = 4000) => {
    const id = nextId();
    set((state) => ({
      toasts: [...state.toasts, { id, message, variant, duration }],
    }));
    setTimeout(() => {
      get().dismiss(id);
    }, duration);
  },

  dismiss: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));

// Convenience helpers for callers that don't want to import the store shape.
export function showToast(message: string, variant: ToastVariant = "default", duration?: number) {
  useToastStore.getState().show(message, variant, duration);
}
