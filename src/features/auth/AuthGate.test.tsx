import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, CloudUser } from "@shared/types";
import { AuthGate } from "./AuthGate";
import { CLOUD_AUTH_CHANGED_EVENT, CloudApiError, setCloudToken } from "../../lib/cloudApi";

const activeUser: CloudUser = {
  id: "user-1",
  phone: "18338062216",
  role: "member",
  membershipPlan: "monthly",
  membershipExpiresAt: "2099-01-01T00:00:00.000Z",
};

const settings: AppSettings = {
  cloudApiBaseUrl: "https://api.example.test",
  defaultSourceRoot: "",
  defaultOutputRoot: "",
  baiduCookie: "",
  watermarkPath: "",
  contentRoot: "",
  uploadExcelPath: "",
  uploadMaxItems: 100,
  listedUpdateMaxWorkers: 2,
  imageProvider: "pixel",
  textProvider: "xiaoqian",
  imageBaseUrl: "",
  textBaseUrl: "",
  imageModel: "",
  textModel: "",
  maxWorkers: 3,
  maxFolders: 0,
  exportExcel: true,
  convertOriginals: true,
  generateCopy: false,
  quality: "high",
  sceneSourceRoot: "",
  sceneOutputRoot: "",
  sceneMockupRoot: "",
  sceneSingleImage: "",
  sceneAspectRatio: "1:1",
  sceneCount: 8,
  sceneMaxWorkers: 2,
  sceneMaxFolders: 0,
  sceneSizeLabel: "",
  scenePromptTemplate: "",
  imagePromptTemplate: "",
  titlePromptTemplate: "",
  descriptionPromptTemplate: "",
  selectedTemplateName: "",
  materialPortraitSourceRoot: "",
  materialPortraitOutputRoot: "",
  materialPortraitMaxItems: 0,
  materialTitleSourceRoot: "",
  materialTitleOutputRoot: "",
  materialTitleMaxItems: 0,
  materialRenameSourceRoot: "",
  materialRenameOutputRoot: "",
  materialRenamePrefix: "",
};

const meMock = vi.fn();

vi.mock("../../lib/cloudApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/cloudApi")>("../../lib/cloudApi");
  return {
    ...actual,
    createCloudClient: () => ({
      me: meMock,
      login: vi.fn(),
      register: vi.fn(),
      redeemLicense: vi.fn(),
    }),
  };
});

vi.mock("../../lib/api", () => ({
  api: {
    getDeviceFingerprint: vi.fn(),
  },
}));

vi.mock("../../lib/localAssistant", () => ({
  checkLocalAssistant: vi.fn().mockResolvedValue({ connected: false }),
  checkLocalAssistantWithGracePeriod: vi.fn().mockResolvedValue({ connected: true }),
  getCloudSyncStatus: vi.fn().mockResolvedValue([
    { accountId: "user-1", scope: "gallery", completed: true, syncing: false, cursor: 1 },
    { accountId: "user-1", scope: "featured", completed: true, syncing: false, cursor: 1 },
  ]),
  startCloudSync: vi.fn().mockResolvedValue({ ok: true, started: false }),
  resolveWebDeviceFingerprint: vi.fn().mockResolvedValue("web-device-fingerprint"),
}));

describe("AuthGate", () => {
  beforeEach(() => {
    window.localStorage.clear();
    meMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("keeps the active workspace during transient silent auth failures", async () => {
    meMock
      .mockResolvedValueOnce({ ok: true, user: activeUser })
      .mockRejectedValue(new CloudApiError("登录已失效，请重新登录", 401, "AUTH_EXPIRED"));
    setCloudToken("token");

    render(
      <AuthGate settings={settings}>
        <div>工作台内容</div>
      </AuthGate>,
    );

    expect(await screen.findByText("工作台内容")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event(CLOUD_AUTH_CHANGED_EVENT));
    });

    await waitFor(() => expect(meMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("工作台内容")).toBeTruthy();
    expect(screen.queryByText("会员授权登录")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event(CLOUD_AUTH_CHANGED_EVENT));
    });

    await waitFor(() => expect(meMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText("工作台内容")).toBeTruthy();
    expect(screen.queryByText("会员授权登录")).toBeNull();
  });
});
