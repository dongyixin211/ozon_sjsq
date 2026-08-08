import assert from "node:assert/strict";
import test from "node:test";

import { directListingImageUrl } from "./listing-image-url.js";

test("listing batches retain the client direct-upload OSS URL", () => {
  const publicUrl = "https://cdn.example.com/gallery/mockup/item.jpg?x-oss-process=image/format,webp";

  assert.equal(directListingImageUrl(publicUrl), publicUrl);
});