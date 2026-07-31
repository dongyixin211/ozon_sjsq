import { ImageUp, LogIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, Shop } from "@shared/types";
import { GalleryManager } from "./GalleryManager";
import { createCloudClient, getCloudToken, type CloudShop } from "../../lib/cloudApi";

interface Props {
  shops: Shop[];
  settings: AppSettings;
  mode: "upload" | "pending" | "processing" | "uploaded" | "featured";
  onChanged?: () => void | Promise<void>;
  onNavigate?: (page: "jobs" | "ozon" | "imageUpload" | "imageProcessing") => void;
}

export function CloudPage({ shops, settings, mode, onChanged, onNavigate }: Props) {
  const client = useMemo(() => createCloudClient(settings.cloudApiBaseUrl), [settings.cloudApiBaseUrl]);
  const [message, setMessage] = useState("");
  const [cloudShops, setCloudShops] = useState<CloudShop[]>([]);
  const [loadingShops, setLoadingShops] = useState(false);
  const signedIn = Boolean(getCloudToken());

  const activeShops = useMemo(
    () => shops
      .filter((shop) => shop.enabled)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" })),
    [shops],
  );

  const unsyncedShops = useMemo(() => {
    const cloudShopIds = new Set(cloudShops.map(readExternalShopId));
    return activeShops.filter((shop) => !cloudShopIds.has(shop.id));
  }, [activeShops, cloudShops]);

  const refreshCloudShops = useCallback(async () => {
    const result = await client.listShops();
    setCloudShops(result.shops);
  }, [client]);

  const syncActiveShops = useCallback(async (notify = false) => {
    if (!signedIn) {
      return;
    }
    setLoadingShops(true);
    try {
      const listed = await client.listShops();
      setCloudShops(listed.shops);
      const cloudShopIds = new Set(listed.shops.map(readExternalShopId));
      const missingShops = activeShops.filter((shop) => !cloudShopIds.has(shop.id));
      if (missingShops.length > 0) {
        await Promise.all(missingShops.map((shop) => client.syncShop(shop)));
      }
      const refreshed = await client.listShops();
      setCloudShops(refreshed.shops);
      if (!notify) {
        return;
      }
      if (missingShops.length > 0) {
        setMessage(`已自动同步店铺到云端：${missingShops.map((shop) => shop.name).join("、")}`);
        await onChanged?.();
      }
    } catch (error) {
      if (!notify) {
        console.warn("Shop auto sync to cloud failed", error);
        return;
      }
      setMessage(`店铺自动同步到云端失败：${readableError(error)}`);
    } finally {
      setLoadingShops(false);
    }
  }, [activeShops, client, onChanged, signedIn]);

  useEffect(() => {
    syncActiveShops(false);
  }, [syncActiveShops]);

  if (!signedIn) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">云端图片库</p>
            <h2>请先登录云端账号</h2>
          </div>
          <LogIn size={22} />
        </div>
        <p className="muted">登录后才能同步店铺、上传图片和继续上架。</p>
        <button className="primary-button" onClick={() => onNavigate?.("ozon")}>
          去店铺管理
        </button>
      </section>
    );
  }

  return (
    <>
      {message ? <section className="panel"><span className={message.includes("失败") ? "badge warn" : "badge"}>{message}</span></section> : null}
      {unsyncedShops.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">店铺同步</p>
              <h2>正在自动同步到云端：{unsyncedShops.map((shop) => shop.name).join("、")}</h2>
            </div>
            <ImageUp size={22} />
          </div>
          <p className="muted">同步完成后会自动刷新，继续上传会使用最新店铺列表。</p>
          <button className="secondary-button" disabled={loadingShops} onClick={() => syncActiveShops(true)}>
            {loadingShops ? "同步中" : "重新同步"}
          </button>
        </section>
      ) : null}
      <GalleryManager
        mode={mode}
        client={client}
        shops={cloudShops}
        localShops={activeShops}
        cloudApiBaseUrl={settings.cloudApiBaseUrl}
        defaultPageSize={10}
        onMessage={setMessage}
        onNavigate={onNavigate}
        onCloudShopsChanged={refreshCloudShops}
      />
    </>
  );
}

function readExternalShopId(shop: CloudShop) {
  return shop.externalShopId || shop.external_shop_id || shop.id;
}

function readableError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
}
