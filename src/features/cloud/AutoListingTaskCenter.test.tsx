import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutoListingTaskCenterAssignment,
  AutoListingTaskCenterProps,
  AutoListingTaskCenterTask,
} from "./AutoListingTaskCenter";
import { AutoListingTaskCenter } from "./AutoListingTaskCenter";

afterEach(() => {
  cleanup();
});

function buildAssignment(overrides: Partial<AutoListingTaskCenterAssignment>): AutoListingTaskCenterAssignment {
  return {
    id: "assignment-1",
    sourceAssetId: "asset-1",
    sourceSku: "SKU-001",
    shopName: "店铺 A",
    externalShopId: "shop-a",
    status: "reserved",
    canRelease: false,
    ...overrides,
  };
}

function buildTask(overrides: Partial<AutoListingTaskCenterTask>): AutoListingTaskCenterTask {
  return {
    id: "run-1",
    label: "今日批次 1",
    stage: "waiting",
    totalCount: 53,
    completedCount: 0,
    failedCount: 0,
    shopAllocations: [{ externalShopId: "shop-a", shopName: "店铺 A", count: 53 }],
    assignments: [],
    ...overrides,
  };
}

function renderTaskCenter(overrides: Partial<AutoListingTaskCenterProps> = {}) {
  const props: AutoListingTaskCenterProps = {
    summary: {
      total: 53,
      waiting: 10,
      preparing: 18,
      submitting: 5,
      completed: 17,
      failed: 3,
      dateLabel: "2026-07-28",
    },
    tasks: [
      buildTask({ id: "run-waiting", label: "等待中批次", stage: "waiting" }),
      buildTask({ id: "run-preparing", label: "准备中批次", stage: "preparing" }),
      buildTask({ id: "run-submitting", label: "提交中批次", stage: "submitting" }),
      buildTask({ id: "run-completed", label: "已完成批次", stage: "completed" }),
      buildTask({ id: "run-failed", label: "失败批次", stage: "failed" }),
    ],
    loading: false,
    error: "",
    onRefresh: vi.fn(),
    onPauseTask: vi.fn(),
    onContinueTask: vi.fn(),
    onRetryFailedOnly: vi.fn(),
    onReleaseAssignment: vi.fn(),
    ...overrides,
  };

  return render(<AutoListingTaskCenter {...props} />);
}

describe("AutoListingTaskCenter", () => {
  it("renders task counts from run data and exposes task actions", () => {
    const onPauseTask = vi.fn();
    const onContinueTask = vi.fn();
    const onRetryFailedOnly = vi.fn();
    renderTaskCenter({
      onPauseTask,
      onContinueTask,
      onRetryFailedOnly,
    });

    expect(screen.getByText("53")).toBeTruthy();
    expect(screen.getByText("等待中批次")).toBeTruthy();
    expect(screen.getByText("准备中批次")).toBeTruthy();
    expect(screen.getByText("提交中批次")).toBeTruthy();
    expect(screen.getByText("已完成批次")).toBeTruthy();
    expect(screen.getByText("失败批次")).toBeTruthy();

    const waitingTaskCard = screen.getByText("等待中批次").closest(".task-card");
    expect(waitingTaskCard).toBeTruthy();
    fireEvent.click(within(waitingTaskCard as HTMLElement).getByRole("button", { name: "暂停" }));
    fireEvent.click(within(waitingTaskCard as HTMLElement).getByRole("button", { name: "继续" }));
    fireEvent.click(within(waitingTaskCard as HTMLElement).getByRole("button", { name: "仅重试失败" }));

    expect(onPauseTask).toHaveBeenCalledWith("run-waiting");
    expect(onContinueTask).toHaveBeenCalledWith("run-waiting");
    expect(onRetryFailedOnly).toHaveBeenCalledWith("run-waiting");
  });

  it("shows assignment details only after expansion and release confirmation only for releasable assignments", () => {
    const onReleaseAssignment = vi.fn();
    renderTaskCenter({
      tasks: [
        buildTask({
          id: "run-release",
          label: "释放检查批次",
          stage: "preparing",
          assignments: [
            buildAssignment({
              id: "assignment-release",
              sourceAssetId: "asset-release",
              sourceSku: "SKU-RELEASE",
              canRelease: true,
            }),
            buildAssignment({
              id: "assignment-locked",
              sourceAssetId: "asset-locked",
              sourceSku: "SKU-LOCKED",
              status: "preparing",
              batchId: "batch-locked",
              canRelease: false,
            }),
          ],
        }),
      ],
      onReleaseAssignment,
    });

    expect(screen.queryByText("SKU-RELEASE")).toBeNull();
    expect(screen.queryByText("SKU-LOCKED")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开图片明细" }));

    expect(screen.getByText("SKU-RELEASE")).toBeTruthy();
    expect(screen.getByText("SKU-LOCKED")).toBeTruthy();

    const taskCard = screen.getByText("释放检查批次").closest(".task-card");
    expect(taskCard).toBeTruthy();
    const releaseButtons = within(taskCard as HTMLElement).getAllByRole("button", { name: "释放确认" });
    expect(releaseButtons).toHaveLength(1);

    fireEvent.click(releaseButtons[0]);
    expect(onReleaseAssignment).toHaveBeenCalledWith("run-release", "assignment-release");
  });

  it("shows quota errors and labels legacy batches as manual batches", () => {
    renderTaskCenter({
      tasks: [
        buildTask({
          id: "run-manual",
          label: "历史批次",
          stage: "waiting",
          legacyLabel: "手动批次",
          quotaError: "店铺 A 创建额度不足",
        }),
      ],
    });

    expect(screen.getByText("手动批次")).toBeTruthy();
    expect(screen.getByText("店铺 A 创建额度不足")).toBeTruthy();
  });
});
