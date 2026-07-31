import { describe, expect, it } from "vitest";
import { hasBaiduBdussCookie, parseOrderNumbers, selectedPostingNumbersInRowOrder } from "./orderUtils";

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

  it("derives selected posting numbers from loaded rows and excludes a logistics URL", () => {
    const rows = [
      { postingNumber: "POSTING-2", productsCount: 1 },
      { postingNumber: "POSTING-1", productsCount: 1 },
    ];

    expect(selectedPostingNumbersInRowOrder(rows, [
      "POSTING-1",
      "https://youla-gl.ilinexpress.com/gl/label.pdf",
      "POSTING-2",
    ])).toEqual(["POSTING-2", "POSTING-1"]);
  });

  it("requires a non-empty BDUSS cookie", () => {
    expect(hasBaiduBdussCookie("BDUSS=token; STOKEN=other")).toBe(true);
    expect(hasBaiduBdussCookie("STOKEN=other")).toBe(false);
    expect(hasBaiduBdussCookie("BDUSS= ; STOKEN=other")).toBe(false);
  });
});
