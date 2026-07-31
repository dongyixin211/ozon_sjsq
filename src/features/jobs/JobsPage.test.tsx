import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobLog, JobSummary } from "@shared/types";
import { api } from "../../lib/api";
import { createCloudClient, getCloudToken } from "../../lib/cloudApi";
import { JobsPage } from "./JobsPage";

vi.mock("../../lib/cloudApi", () => ({
  createCloudClient: vi.fn(),
  getCloudToken: vi.fn(() => ""),
}));

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(getCloudToken).mockReturnValue("");
  vi.mocked(createCloudClient).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it("ignores an older log response after selecting a different job", async () => {
    const secondJob: JobSummary = { ...baseJob, id: "job-2", title: "更新任务", kind: "listed_update" };
    const firstRequest = deferred<JobLog[]>();
    const secondRequest = deferred<JobLog[]>();
    vi.spyOn(api, "listJobLogs").mockImplementation((jobId) => (
      jobId === "job-1" ? firstRequest.promise : secondRequest.promise
    ));

    render(<JobsPage jobs={[baseJob, secondJob]} onChanged={vi.fn()} />);

    await waitFor(() => expect(api.listJobLogs).toHaveBeenCalledWith("job-1"));
    fireEvent.click(screen.getAllByRole("button", { name: "日志" })[1]);
    await waitFor(() => expect(api.listJobLogs).toHaveBeenCalledWith("job-2"));

    await act(async () => {
      secondRequest.resolve([log("job-2", "最新任务日志")]);
      await secondRequest.promise;
    });
    expect(screen.getByText((text) => text.includes("最新任务日志"))).toBeTruthy();

    await act(async () => {
      firstRequest.resolve([log("job-1", "过期任务日志")]);
      await firstRequest.promise;
    });
    expect(screen.queryByText((text) => text.includes("过期任务日志"))).toBeNull();
    expect(screen.getByText((text) => text.includes("最新任务日志"))).toBeTruthy();
  });

  it("paginates task records with ten rows by default", async () => {
    vi.spyOn(api, "listJobLogs").mockResolvedValue([log("job-1", "第一页任务日志")]);
    const jobs: JobSummary[] = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      return {
        ...baseJob,
        id: `job-${number}`,
        title: `任务记录 ${number}`,
        updatedAt: `2026-06-13T00:${String(number).padStart(2, "0")}:00.000Z`,
      };
    });

    render(<JobsPage jobs={jobs} onChanged={vi.fn()} />);

    expect(await screen.findAllByText("任务记录 1")).toHaveLength(2);
    expect(screen.getByText("任务记录 10")).toBeTruthy();
    expect(screen.queryByText("任务记录 11")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "下一页" })[0]);

    expect(await screen.findByText("任务记录 11")).toBeTruthy();
    expect(screen.getByText("任务记录 12")).toBeTruthy();
  });

  it("shows an empty log hint when the selected job has no logs", async () => {
    const listJobLogs = vi.spyOn(api, "listJobLogs").mockResolvedValue([]);

    render(<JobsPage jobs={[baseJob]} onChanged={vi.fn()} />);

    await waitFor(() => expect(listJobLogs).toHaveBeenCalledWith("job-1"));
    expect(screen.getByText("选择任务后查看日志。")).toBeTruthy();
  });

  it("syncs local jobs and selected logs to cloud when signed in", async () => {
    const syncTaskHistory = vi.fn().mockResolvedValue({ ok: true, jobsSynced: 1, logsSynced: 1 });
    vi.mocked(getCloudToken).mockReturnValue("test-token");
    vi.mocked(createCloudClient).mockReturnValue({
      syncTaskHistory,
    } as unknown as ReturnType<typeof createCloudClient>);
    vi.spyOn(api, "listJobLogs").mockResolvedValue([log("job-1", "同步日志")]);

    render(<JobsPage jobs={[baseJob]} cloudApiBaseUrl="http://127.0.0.1:9876" onChanged={vi.fn()} />);

    await waitFor(() => expect(api.listJobLogs).toHaveBeenCalledWith("job-1"));
    await waitFor(() => expect(createCloudClient).toHaveBeenCalledWith("http://127.0.0.1:9876"));
    await waitFor(() => {
      const syncedWithLogs = syncTaskHistory.mock.calls.some(([input]) => (
        input.jobs.length === 1
        && input.jobs[0].id === "job-1"
        && input.logs.length === 1
        && input.logs[0].message === "同步日志"
      ));
      expect(syncedWithLogs).toBe(true);
    });
    expect(await screen.findByText("已同步到云端：1 个任务 / 1 条日志")).toBeTruthy();
  });
});
