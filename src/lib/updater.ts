import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateCheckResult {
  update: Update | null;
  required: boolean;
}

export async function checkDesktopUpdate(): Promise<UpdateCheckResult> {
  const update = await check();
  return {
    update,
    required: Boolean(update?.body?.includes("[required]")),
  };
}

export async function installDesktopUpdate(
  update: Update,
  onProgress?: (event: DownloadEvent) => void,
) {
  await update.downloadAndInstall(onProgress);
  await relaunch();
}
