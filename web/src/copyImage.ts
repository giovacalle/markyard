// Copying an attachment's original image to the clipboard. Browsers only promise `image/png`
// clipboard items, so JPEG, WebP and GIF images are redrawn into a PNG first (a GIF keeps its
// first frame).

/** The image at `url` as a PNG blob. */
export async function pngBlobOf(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Unable to load the image (${response.status}).`);
  }
  const blob = await response.blob();
  if (blob.type === "image/png") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    bitmap.close();
    throw new Error("Unable to convert the image.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (png) => (png === null ? reject(new Error("Unable to convert the image.")) : resolve(png)),
      "image/png",
    ),
  );
}

/** Whether this browser can put an image on the clipboard. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";
}

/**
 * Puts the original image at `url` on the clipboard. Call it straight from the click handler:
 * Safari only allows the write when the `ClipboardItem` is made inside the user gesture, so the
 * download goes in as a pending blob.
 */
export function copyImage(url: string): Promise<void> {
  if (!canCopyImages()) {
    return Promise.reject(new Error("This browser cannot copy images."));
  }
  return navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlobOf(url) })]);
}
