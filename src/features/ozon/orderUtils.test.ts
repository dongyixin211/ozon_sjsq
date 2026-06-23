import { describe, expect, it } from "vitest";
import { hasBaiduBdussCookie, parseOrderNumbers } from "./orderUtils";

describe("Ozon order utilities", () => {
  it("splits pasted order numbers and removes duplicates", () => {
    expect(parseOrderNumbers("123-1, 123-1\n456；789 456")).toEqual([
      "123-1",
      "456",
      "789",
    ]);
  });

  it("ignores empty separators", () => {
    expect(parseOrderNumbers(" ,， ;； \n ")).toEqual([]);
  });

  it("requires a non-empty BDUSS cookie", () => {
    expect(hasBaiduBdussCookie("BDUSS=token; STOKEN=other")).toBe(true);
    expect(hasBaiduBdussCookie("STOKEN=other")).toBe(false);
    expect(hasBaiduBdussCookie("BDUSS= ; STOKEN=other")).toBe(false);
  });
});
