import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { en, ru, translate, errorKey } from "../google-pwa/locales.js";

test("workspace English and Russian dictionaries have matching complete keys", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  for (const dictionary of [en, ru]) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(typeof value === "string" || typeof value === "object", key);
      for (const text of typeof value === "object"
        ? Object.values(value)
        : [value])
        assert.ok(typeof text === "string" && text.length > 0, key);
    }
  }
});

test("all literal main-interface translation keys exist in both languages", async () => {
  const source = await readFile(
    new URL("../google-pwa/workspace.js", import.meta.url),
    "utf8",
  );
  const keys = [
    ...source.matchAll(/\bt\(["']([^"']+)["']/g),
    ...source.matchAll(/data-i18n=["']([^"']+)["']/g),
    ...source.matchAll(/\bflash\(["']([^"']+)["']/g),
  ].map((match) => match[1]);
  for (const key of keys) {
    assert.ok(Object.hasOwn(en, key), `English: ${key}`);
    assert.ok(Object.hasOwn(ru, key), `Russian: ${key}`);
  }
});

test("plural forms, validation and connection failures stay in the selected language", () => {
  assert.equal(translate("en", "itemCount", { count: 1 }), "1 product");
  assert.equal(translate("en", "itemCount", { count: 2 }), "2 products");
  assert.equal(translate("ru", "itemCount", { count: 1 }), "1 товар");
  assert.equal(translate("ru", "itemCount", { count: 2 }), "2 товара");
  assert.equal(translate("ru", "itemCount", { count: 5 }), "5 товаров");
  for (const message of [
    "INVALID_QUANTITY",
    "INVALID_LOGIN",
    "STOCK_CONFLICT",
    "UNIT_HAS_HISTORY",
    "SIGN_IN_REQUIRED",
    "Connection interrupted",
    "Invalid URL",
    "unexpected network exception",
  ]) {
    const key = errorKey(Error(message));
    assert.notEqual(translate("en", key), translate("ru", key));
    assert.match(translate("ru", key), /[а-яё]/i);
  }
});
