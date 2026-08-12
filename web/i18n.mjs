let chinese = typeof navigator !== "undefined"
  && String(navigator.language || "").toLowerCase().startsWith("zh");

export function setPromptPresetLocale(locale) {
  chinese = String(locale || "en").toLowerCase().startsWith("zh");
}

export function isChinese() {
  return chinese;
}

export function localeCode() {
  return chinese ? "zh" : "en";
}

export function tr(zh, en) {
  return chinese ? zh : en;
}
