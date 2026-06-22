import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobLog, JobSummary } from "@shared/types";
import { api } from "../../lib/api";
import { JobsPage } from "./JobsPage";

const baseJob: JobSummary = {
  id: "job-1",
  kind: "batch_upload",
  title: "批量上架任务",
  status: "succeeded",
  progress: 100,
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z",
};

function log(jobId: string, message: string): JobLog {
  return {
    id: `${jobId}-log`,
    jobId,
    level: "info",
    message,
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("JobsPage", () => {
  it("loads logs for the first job by default", async () => {
    const listJobLogs = vi.spyOn(api, "listJobLogs").mockResolvedValue([log("job-1", "默认日志")]);

    render(<JobsPage jobs={[baseJob]} onChanged={vi.fn()} />);

    await waitFor(() => expect(listJobLogs).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByText((text) => text.includes("默认日志"))).toBeTruthy();
  });

  it("loads logs when another job is selected", async () => {
    const secondJob: JobSummary = { ...baseJob, id: "job-2", title: "更新任务", kind: "listed_update" };
    vi.spyOn(api, "listJobLogs").mockImplementation(async (jobId) => [log(jobId, jobId === "job-2" ? "第二条日志" : "第一条日志")]);

    render(<JobsPage jobs={[baseJob, secondJob]} onChanged={vi.fn()} />);
    await screen.findByText((text) => text.includes("第一条日志"));

    const logButtons = screen.getAllByRole("button", { name: "日志" });
    fireEvent.click(logButtons[1]);

    expect(await screen.findByText((text) => text.includes("第二条日志"))).toBeTruthy();
  });

  it("shows an empty log hint when the selected job has no logs", async () => {
    const listJobLogs = vi.spyOn(api, "listJobLogs").mockResolvedValue([]);

    render(<JobsPage jobs={[baseJob]} onChanged={vi.fn()} />);

    await waitFor(() => expect(listJobLogs).toHaveBeenCalledWith("job-1"));
    expect(screen.getByText("选择任务后查看日志。")).toBeTruthy();
  });
});
