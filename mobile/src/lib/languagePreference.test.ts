import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import {
  LANGUAGE_STORAGE_KEY_GLOBAL,
  languageFromDeviceTags,
  languageStorageKeyForUser,
  parseStoredLanguage,
  resolveLanguage,
} from "./languagePreference";

describe("parseStoredLanguage", () => {
  it("accepts only the two supported codes", () => {
    expect(parseStoredLanguage("he")).toBe("he");
    expect(parseStoredLanguage("en")).toBe("en");
    expect(parseStoredLanguage("HE")).toBeNull();
    expect(parseStoredLanguage("fr")).toBeNull();
    expect(parseStoredLanguage("")).toBeNull();
    expect(parseStoredLanguage(null)).toBeNull();
    expect(parseStoredLanguage(undefined)).toBeNull();
  });
});

describe("languageFromDeviceTags", () => {
  it("returns the first Hebrew or English tag in preference order", () => {
    expect(languageFromDeviceTags(["he-IL", "en-US"])).toBe("he");
    expect(languageFromDeviceTags(["en-US", "he-IL"])).toBe("en");
    expect(languageFromDeviceTags(["fr-FR", "he"])).toBe("he");
    expect(languageFromDeviceTags(["iw-IL"])).toBe("he");
    expect(languageFromDeviceTags(["he_IL"])).toBe("he");
  });
  it("returns null when no supported language is listed", () => {
    expect(languageFromDeviceTags(["fr-FR", "ar"])).toBeNull();
    expect(languageFromDeviceTags([])).toBeNull();
    expect(languageFromDeviceTags([null, undefined, ""])).toBeNull();
  });
  it("does not treat other languages that merely start with he/en letters as matches", () => {
    expect(languageFromDeviceTags(["hr-HR"])).toBeNull();
    expect(languageFromDeviceTags(["eo"])).toBeNull();
  });
});

describe("resolveLanguage", () => {
  it("prefers the saved per-user choice over everything", () => {
    expect(resolveLanguage({ userStored: "en", globalStored: "he", deviceTags: ["he-IL"] })).toBe("en");
    expect(resolveLanguage({ userStored: "he", globalStored: "en", deviceTags: ["en-US"] })).toBe("he");
  });
  it("falls back to the saved device-level choice", () => {
    expect(resolveLanguage({ globalStored: "en", deviceTags: ["he-IL"] })).toBe("en");
    expect(resolveLanguage({ globalStored: "he", deviceTags: ["en-US"] })).toBe("he");
  });
  it("uses the device language only when nothing valid is saved", () => {
    expect(resolveLanguage({ deviceTags: ["he-IL"] })).toBe("he");
    expect(resolveLanguage({ userStored: "garbage", globalStored: null, deviceTags: ["he-IL"] })).toBe("he");
    expect(resolveLanguage({ deviceTags: ["en-GB"] })).toBe("en");
  });
  it("defaults to English", () => {
    expect(resolveLanguage({})).toBe("en");
    expect(resolveLanguage({ deviceTags: ["fr-FR"] })).toBe("en");
  });
});

describe("storage keys", () => {
  it("keeps the established key names (existing saved choices must keep working)", () => {
    expect(LANGUAGE_STORAGE_KEY_GLOBAL).toBe("shira_fit_language");
    expect(languageStorageKeyForUser("abc-123")).toBe("shira_fit_language_abc-123");
  });
});

describe("public/index.html first-paint script", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");
  const match = /<script id="initial-language">([\s\S]*?)<\/script>/.exec(html);

  function runScript(saved: string | null, languages: string[], throwOnStorage = false) {
    const documentElement = { lang: "", dir: "" };
    const context = {
      localStorage: {
        getItem: (key: string) => {
          if (throwOnStorage) throw new Error("blocked");
          return key === LANGUAGE_STORAGE_KEY_GLOBAL ? saved : null;
        },
      },
      navigator: { languages, language: languages[0] },
      document: { documentElement },
    };
    vm.runInNewContext(match![1], context);
    return documentElement;
  }

  it("exists", () => {
    expect(match).not.toBeNull();
  });

  const cases: [string | null, string[]][] = [
    ["he", ["en-US"]],
    ["en", ["he-IL"]],
    [null, ["he-IL", "en-US"]],
    [null, ["en-US", "he-IL"]],
    [null, ["fr-FR", "he"]],
    [null, ["fr-FR"]],
    [null, []],
    ["garbage", ["he-IL"]],
  ];
  it.each(cases)("matches resolveLanguage for saved=%p, device=%p", (saved, languages) => {
    const expected = resolveLanguage({ globalStored: saved, deviceTags: languages });
    const el = runScript(saved, languages);
    expect(el.lang).toBe(expected);
    expect(el.dir).toBe(expected === "he" ? "rtl" : "ltr");
  });

  it("still sets lang/dir when storage access throws", () => {
    const el = runScript(null, ["he-IL"], true);
    expect(el).toEqual({ lang: "he", dir: "rtl" });
  });
});
