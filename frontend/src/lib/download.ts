/**
 * Hands a file to the browser as a download: an export built on the page, or
 * one the backend generated.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  // Revoked on the next turn of the loop rather than immediately: Safari has
  // not started the download when `click()` returns, and a revoked URL there
  // produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
