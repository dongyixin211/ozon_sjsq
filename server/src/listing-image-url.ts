export function directListingImageUrl(publicUrl: string): string {
  const url = publicUrl.trim();
  if (!url) {
    throw new Error("Direct listing image URL is required.");
  }
  return url;
}