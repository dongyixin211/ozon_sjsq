import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { ScenePage } from "./ScenePage";

vi.mock("../../lib/api", () => ({
  api: {
    startLocalSceneJob: vi.fn().mockResolvedValue({
      id: "scene-job-1",
      kind: "scene_local",
      title: "本地场景图合成",
      status: "running",
      progress: 5,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    }),
    pickDirectory: vi.fn(),
    pickFile: vi.fn(),
  },
}));

describe("ScenePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.startLocalSceneJob).mockClear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("persists scene settings and submits the selected single image", async () => {
    const onJobStarted = vi.fn();
    const { container, unmount } = render(<ScenePage onJobStarted={onJobStarted} />);

    const textboxes = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(textboxes[0], { target: { value: "E:\\source-images" } });
    fireEvent.change(textboxes[1], { target: { value: "E:\\scene-output" } });
    fireEvent.change(textboxes[2], { target: { value: "E:\\mockups" } });
    fireEvent.change(textboxes[3], { target: { value: "E:\\single\\sku-001.png" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "3:4" } });
    fireEvent.change(textboxes[4], { target: { value: "35.83 x 35.83 inches" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12" } });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    fireEvent.click(container.querySelector(".primary-button") as HTMLButtonElement);

    await waitFor(() => expect(api.startLocalSceneJob).toHaveBeenCalledWith({
      sourceRoot: "E:\\source-images",
      outputRoot: "E:\\scene-output",
      mockupRoot: "E:\\mockups",
      singleImage: "E:\\single\\sku-001.png",
      aspectRatio: "3:4",
      sceneIds: ["flat_full", "headscarf_side"],
      sizeLabel: "35.83 x 35.83 inches",
      maxItems: 12,
    }));
    expect(onJobStarted).toHaveBeenCalled();

    unmount();
    render(<ScenePage onJobStarted={vi.fn()} />);

    expect(screen.getByDisplayValue("E:\\source-images")).toBeTruthy();
    expect(screen.getByDisplayValue("E:\\scene-output")).toBeTruthy();
    expect(screen.getByDisplayValue("E:\\mockups")).toBeTruthy();
    expect(screen.getByDisplayValue("E:\\single\\sku-001.png")).toBeTruthy();
    expect(screen.getByDisplayValue("35.83 x 35.83 inches")).toBeTruthy();
    expect(screen.getByDisplayValue("12")).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("3:4");
    expect((screen.getAllByRole("checkbox")[1] as HTMLInputElement).checked).toBe(true);
  });
});
