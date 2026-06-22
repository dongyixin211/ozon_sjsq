import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LongOutput } from "./LongOutput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LongOutput", () => {
  it("limits long content by default and can expand it", () => {
    render(<LongOutput value={"line 1\nline 2"} emptyText="暂无内容" />);

    const output = screen.getByText(/line 1/);
    expect(output.className).toContain("long-output-box");
    expect(output.className).not.toContain("expanded");

    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(output.className).toContain("expanded");
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
  });

  it("copies and clears content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onClear = vi.fn();
    render(<LongOutput value="payload" emptyText="暂无内容" onClear={onClear} />);

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("payload"));
    expect(screen.getByText("已复制")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows empty text and disables value-only actions", () => {
    render(<LongOutput value="" emptyText="暂无内容" onClear={vi.fn()} />);

    expect(screen.getByText("暂无内容")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "清空" }).hasAttribute("disabled")).toBe(true);
  });
});
