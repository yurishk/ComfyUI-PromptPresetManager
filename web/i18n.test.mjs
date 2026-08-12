import assert from "node:assert/strict";
import test from "node:test";

import { localeCode, setPromptPresetLocale, tr } from "./i18n.mjs";

test("locale helper switches visible labels", () => {
  setPromptPresetLocale("en-US");
  assert.equal(localeCode(), "en");
  assert.equal(tr("预设", "Preset"), "Preset");

  setPromptPresetLocale("zh-CN");
  assert.equal(localeCode(), "zh");
  assert.equal(tr("预设", "Preset"), "预设");

  setPromptPresetLocale("en-US");
});
