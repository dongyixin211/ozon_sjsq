import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLocalAssistant } from "./localAssistant";

function healthResponse() {
  return new Response(JSON.stringify({ protocolVersion: 4 }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkLocalAssistant", () => {
  it("shares an in-flight health request", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((next) => {
      resolve = next;
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));

    const first = checkLocalAssistant();
    const second = checkLocalAssistant();

    expect(window.fetch).toHaveBeenCalledTimes(1);
    resolve(healthResponse());

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ connected: true, state: "connected" }),
      expect.objectContaining({ connected: true, state: "connected" }),
    ]);
  });

  it("starts a new request after the shared probe settles", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(healthResponse());
    vi.stubGlobal("fetch", fetchMock);

    await checkLocalAssistant();
    await checkLocalAssistant();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
