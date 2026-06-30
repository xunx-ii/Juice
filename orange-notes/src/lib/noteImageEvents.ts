export const NOTE_IMAGE_AVAILABLE_EVENT = "orange-notes:note-image-available";

export function notifyNoteImageAvailable(fileName: string) {
  window.dispatchEvent(
    new CustomEvent(NOTE_IMAGE_AVAILABLE_EVENT, {
      detail: { fileName },
    })
  );
}

export function noteImageAvailableFileName(event: Event): string | null {
  const detail = (event as CustomEvent<{ fileName?: unknown }>).detail;
  return typeof detail?.fileName === "string" ? detail.fileName : null;
}
