export const NOTE_IMAGE_AVAILABLE_EVENT = "orange-notes:note-image-available";
export const NOTE_IMAGE_DELETED_EVENT = "orange-notes:note-image-deleted";

export function notifyNoteImageAvailable(fileName: string) {
  window.dispatchEvent(
    new CustomEvent(NOTE_IMAGE_AVAILABLE_EVENT, {
      detail: { fileName },
    })
  );
}

export function notifyNoteImageDeleted(fileName: string) {
  window.dispatchEvent(
    new CustomEvent(NOTE_IMAGE_DELETED_EVENT, {
      detail: { fileName },
    })
  );
}

export function notifyNoteImagesDeleted(fileNames: string[]) {
  for (const fileName of new Set(fileNames)) {
    notifyNoteImageDeleted(fileName);
  }
}

export function noteImageAvailableFileName(event: Event): string | null {
  const detail = (event as CustomEvent<{ fileName?: unknown }>).detail;
  return typeof detail?.fileName === "string" ? detail.fileName : null;
}

export function noteImageDeletedFileName(event: Event): string | null {
  const detail = (event as CustomEvent<{ fileName?: unknown }>).detail;
  return typeof detail?.fileName === "string" ? detail.fileName : null;
}
