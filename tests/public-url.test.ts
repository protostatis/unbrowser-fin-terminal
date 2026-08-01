import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePublicUrl } from "../shared/public-url.js";

test("public URL sanitizer keeps public article URLs and removes tracking metadata", () => {
  const url = sanitizePublicUrl(
    "https://news.example/story?topic=markets&utm_source=feed&fbclid=tracker#section",
  );
  assert.equal(url, "https://news.example/story?topic=markets");
});

test("public URL sanitizer rejects private, credentialed, and unsafe endpoints", () => {
  for (const url of [
    "javascript:alert(1)",
    "https://user:pass@news.example/story",
    "http://localhost/story",
    "http://127.0.0.1/story",
    "http://10.0.0.1/story",
    "https://news.example:444/story",
    "https://news.example/story?access_token=secret",
    "https://news.example/story?id_token=secret",
    "https://news.example/story?refresh-token=secret",
    "https://news.example/story?client_secret=secret",
    "https://news.example/story?private_key=secret",
    "https://news.example/story?bearer=secret",
    "https://news.example/story?X-Amz-Credential=secret",
    "https://news.example/story?X-Amz-Signature=secret",
    "https://news.example/story?X-Amz-Security-Token=secret",
  ]) {
    assert.equal(sanitizePublicUrl(url), "", url);
  }
});
