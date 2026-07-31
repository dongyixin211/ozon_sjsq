import { useEffect, useState } from "react";
import type { AppSettings, ProviderSecretStatus, Shop, ShopDraft } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";

interface Props {
  settings: AppSettings;
  shops: Shop[];
  providerSecrets: ProviderSecretStatus;
  onChanged: () => void;
}

export function SettingsPage({ settings, shops, onChanged }: Props) {
  const [localSettings, setLocalSettings] = useState(settings);
  const [section, setSection] = useState<"shop" | "cloud" | "oss" | "dirs">("shop");
  const [shopDraft, setShopDraft] = useState<ShopDraft>({
    name: "",
    clientId: "",
    apiKey: "",
    ossAccessKeyId: "",
    ossAccessKeySecret: "",
    ossBucket: "dyx-ozon-images",
    ossEndpoint: "oss-cn-beijing.aliyuncs.com",
    ossPublicDomain: "https://dyx-ozon-images.oss-cn-beijing.aliyuncs.com",
    watermarkPath: "",
    shopRole: "main",
    followsShopId: "",
    followWarehouseId: undefined,
    enabled: true,
  });
  const [message, setMessage] = useState("");

  useEffect(() => setLocalSettings(settings), [settings]);

  const saveSettings = async () => {
    await api.saveSettings(localSettings);
    onChanged();
    setMessage("设置已保存。");
  };

  const saveShop = async () => {
    const saved = await api.saveShop(shopDraft);
    setShopDraft({
      name: "",
      clientId: "",
      apiKey: "",
      ossAccessKeyId: "",
      ossAccessKeySecret: "",
      ossBucket: "dyx-ozon-images",
      ossEndpoint: "oss-cn-beijing.aliyuncs.com",
      ossPublicDomain: "https://dyx-ozon-images.oss-cn-beijing.aliyuncs.com",
      watermarkPath: "",
      shopRole: "main",
      followsShopId: "",
      followWarehouseId: undefined,
      enabled: true,
    });
    onChanged();
    try {
      await api.testOzonConnection(saved.id);
      const warehouses = await api.listWarehouses(saved.id);
      setMessage(`店铺已保存，Ozon 连接成功，拉到 ${warehouses.length} 个仓库。`);
    } catch (error) {
      setMessage(`店铺已保存，但 Ozon 测试失败：${error}`);
    }
  };

  return (
    <div className="content-grid">
      {message ? <section className="panel"><span className="badge">{message}</span></section> : null}

      <section className="panel">
        <div className="tabs">
          {[
            ["shop", "店铺与 Ozon"],
            ["cloud", "云服务"],
            ["oss", "OSS 上传"],
            ["dirs", "默认目录"],
          ].map(([key, label]) => (
            <button key={key} className={section === key ? "tab active" : "tab"} onClick={() => setSection(key as "shop" | "cloud" | "oss" | "dirs")}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {section === "cloud" ? <section className="panel">
        <div className="panel-header">
          <div>
            <h2>云服务</h2>
            <p className="muted">用于会员登录、云端图库和设备授权。这里填写你的云后端地址，不填写 R2 密钥。</p>
          </div>
          <button className="primary-button" onClick={saveSettings}>保存设置</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>云后端 API 地址</label>
            <input
              value={localSettings.cloudApiBaseUrl}
              onChange={(event) => setLocalSettings({ ...localSettings, cloudApiBaseUrl: event.target.value })}
              placeholder="https://api.dyxtoolai.cn"
            />
          </div>
        </div>
      </section> : null}

      {/* 店铺配置 */}
      {section === "shop" ? <section className="panel">
        <div className="panel-header">
          <div>
            <h2>店铺与 API Key</h2>
            <p className="muted">
              Client-Id 与 Api-Key 来自 Ozon 卖家后台：
              <a href="https://seller.ozon.ru/app/settings/api-keys" target="_blank" rel="noreferrer"> API Keys</a>
            </p>
          </div>
          <button className="primary-button" onClick={saveShop}>保存店铺</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>店铺名称</label>
            <input value={shopDraft.name} onChange={(event) => setShopDraft({ ...shopDraft, name: event.target.value })} />
          </div>
          <div className="field">
            <label>Client-Id</label>
            <input value={shopDraft.clientId} onChange={(event) => setShopDraft({ ...shopDraft, clientId: event.target.value })} />
          </div>
          <div className="field">
            <label>Api-Key</label>
            <input type="password" value={shopDraft.apiKey} onChange={(event) => setShopDraft({ ...shopDraft, apiKey: event.target.value })} />
          </div>
          <div className="field">
            <label>店铺类型</label>
            <select value={shopDraft.shopRole ?? "main"} onChange={(event) => setShopDraft({
              ...shopDraft,
              shopRole: event.target.value as "main" | "follower",
              followsShopId: event.target.value === "follower" ? shopDraft.followsShopId : "",
              followWarehouseId: event.target.value === "follower" ? shopDraft.followWarehouseId : undefined,
            })}>
              <option value="main">主店</option>
              <option value="follower">跟卖店铺</option>
            </select>
          </div>
          <div className="field">
            <label>跟卖主店</label>
            <select
              value={shopDraft.followsShopId ?? ""}
              disabled={(shopDraft.shopRole ?? "main") !== "follower"}
              onChange={(event) => setShopDraft({ ...shopDraft, followsShopId: event.target.value })}
            >
              <option value="">选择主店</option>
              {shops
                .filter((shop) => shop.id !== shopDraft.id && (shop.shopRole ?? "main") !== "follower")
                .map((shop) => (
                  <option key={shop.id} value={shop.id}>{shop.name} ({shop.clientId})</option>
                ))}
            </select>
          </div>
          <div className="field">
            <label>跟卖唯一仓库 ID</label>
            <input
              type="number"
              min={1}
              disabled={(shopDraft.shopRole ?? "main") !== "follower"}
              value={shopDraft.followWarehouseId ?? ""}
              onChange={(event) => setShopDraft({
                ...shopDraft,
                followWarehouseId: event.target.value ? Number(event.target.value) : undefined,
              })}
            />
          </div>
          <div className="field">
            <label>店铺水印图片</label>
            <PathInput value={shopDraft.watermarkPath ?? ""} onChange={(value) => setShopDraft({ ...shopDraft, watermarkPath: value })} mode="file" />
          </div>
          <div className="field">
            <label>OSS AccessKeyId</label>
            <input value={shopDraft.ossAccessKeyId} onChange={(event) => setShopDraft({ ...shopDraft, ossAccessKeyId: event.target.value })} />
          </div>
        </div>
      </section> : null}

      {/* 已保存店铺 */}
      {section === "shop" ? <section className="panel">
        <div className="panel-header">
          <h2>已保存店铺</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>名称</th><th>Client-Id</th><th>类型</th><th>跟卖主店</th><th>跟卖仓库</th><th>水印</th><th>Ozon Key</th><th>OSS</th><th>操作</th></tr>
            </thead>
            <tbody>
              {shops.map((shop) => (
                <tr key={shop.id}>
                  <td>{shop.name}</td>
                  <td>{shop.clientId}</td>
                  <td>{shopRoleLabel(shop)}</td>
                  <td>{shop.followsShopId ? shops.find((item) => item.id === shop.followsShopId)?.name ?? shop.followsShopId : "-"}</td>
                  <td>{(shop.shopRole ?? "main") === "follower" ? shop.followWarehouseId ?? "未设置" : "-"}</td>
                  <td>{shop.watermarkPath ? "已设置" : "未设置"}</td>
                  <td>{shop.apiKeyStored ? "已保存" : "未保存"}</td>
                  <td>{ossBucketLabel(shop, shops)}</td>
                  <td>
                    <div className="actions">
                      <button className="secondary-button" onClick={() => {
                        setShopDraft({
                          id: shop.id,
                          name: shop.name,
                          clientId: shop.clientId,
                          apiKey: shop.apiKeyPlain ?? "",
                          ossAccessKeyId: shop.ossAccessKeyId ?? "",
                          ossAccessKeySecret: shop.ossSecretPlain ?? "",
                          ossBucket: shop.ossBucket ?? "dyx-ozon-images",
                          ossEndpoint: shop.ossEndpoint ?? "oss-cn-beijing.aliyuncs.com",
                          ossPublicDomain: shop.ossPublicDomain ?? "https://dyx-ozon-images.oss-cn-beijing.aliyuncs.com",
                          watermarkPath: shop.watermarkPath ?? "",
                          shopRole: shop.shopRole ?? "main",
                          followsShopId: shop.followsShopId ?? "",
                          followWarehouseId: shop.followWarehouseId,
                          enabled: shop.enabled,
                        });
                      }}>编辑</button>
                      <button className="secondary-button" onClick={async () => {
                        try {
                          const data = await api.testOzonConnection(shop.id);
                          setMessage(`连接成功：${JSON.stringify(data).slice(0, 120)}`);
                        } catch (error) {
                          setMessage(`连接失败：${error}`);
                        }
                      }}>测试</button>
                      <button className="danger-button" onClick={async () => {
                        await api.deleteShop(shop.id);
                        onChanged();
                      }}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {shops.length === 0 ? <tr><td colSpan={9} className="muted">暂无店铺。</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section> : null}

      {/* 默认目录 */}
      {section === "dirs" ? <section className="panel">
        <div className="panel-header">
          <h2>默认目录</h2>
          <button className="primary-button" onClick={saveSettings}>保存设置</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>默认源目录</label>
            <PathInput value={localSettings.defaultSourceRoot} onChange={(v) => setLocalSettings({ ...localSettings, defaultSourceRoot: v })} placeholder="选择源图根目录" />
          </div>
          <div className="field">
            <label>默认输出目录</label>
            <PathInput value={localSettings.defaultOutputRoot} onChange={(v) => setLocalSettings({ ...localSettings, defaultOutputRoot: v })} placeholder="选择输出目录" />
          </div>
          <div className="field">
            <label>水印图片</label>
            <PathInput value={localSettings.watermarkPath} onChange={(v) => setLocalSettings({ ...localSettings, watermarkPath: v })} mode="file" placeholder="选择水印图片" />
          </div>
          <div className="field">
            <label>文案输出目录</label>
            <PathInput value={localSettings.contentRoot} onChange={(v) => setLocalSettings({ ...localSettings, contentRoot: v })} placeholder="选择文案输出目录" />
          </div>
          <div className="field">
            <label>上架 Excel 模板</label>
            <PathInput value={localSettings.uploadExcelPath} onChange={(v) => setLocalSettings({ ...localSettings, uploadExcelPath: v })} mode="file" placeholder="选择上传 Excel 模板" />
          </div>
          <div className="field">
            <label>上架最大条目</label>
            <input type="number" min={1} max={10000} value={localSettings.uploadMaxItems} onChange={(e) => setLocalSettings({ ...localSettings, uploadMaxItems: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>更新最大并发</label>
            <input type="number" min={1} max={16} value={localSettings.listedUpdateMaxWorkers} onChange={(e) => setLocalSettings({ ...localSettings, listedUpdateMaxWorkers: Number(e.target.value) })} />
          </div>
        </div>
      </section> : null}

      {section === "oss" ? <section className="panel">
        <div className="panel-header">
          <div>
            <h2>OSS 上传</h2>
            <p className="muted">用于批量上架时上传商品图片。可在保存店铺后测试上传。</p>
          </div>
          <button className="primary-button" onClick={saveShop}>保存店铺</button>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>店铺名称</label>
            <input value={shopDraft.name} onChange={(event) => setShopDraft({ ...shopDraft, name: event.target.value })} />
          </div>
          <div className="field">
            <label>Client-Id</label>
            <input value={shopDraft.clientId} onChange={(event) => setShopDraft({ ...shopDraft, clientId: event.target.value })} />
          </div>
          <div className="field">
            <label>OSS AccessKeyId</label>
            <input value={shopDraft.ossAccessKeyId} onChange={(event) => setShopDraft({ ...shopDraft, ossAccessKeyId: event.target.value })} />
          </div>
          <div className="field">
            <label>OSS Secret</label>
            <input type="password" value={shopDraft.ossAccessKeySecret} onChange={(event) => setShopDraft({ ...shopDraft, ossAccessKeySecret: event.target.value })} />
          </div>
          <div className="field">
            <label>OSS Bucket</label>
            <input value={shopDraft.ossBucket} onChange={(event) => setShopDraft({ ...shopDraft, ossBucket: event.target.value })} />
          </div>
          <div className="field">
            <label>OSS Endpoint</label>
            <input value={shopDraft.ossEndpoint} onChange={(event) => setShopDraft({ ...shopDraft, ossEndpoint: event.target.value })} />
          </div>
          <div className="field">
            <label>OSS Public Domain</label>
            <input value={shopDraft.ossPublicDomain} onChange={(event) => setShopDraft({ ...shopDraft, ossPublicDomain: event.target.value })} />
          </div>
        </div>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>店铺</th><th>Bucket</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {shops.map((shop) => (
                <tr key={shop.id}>
                  <td>{shop.name}</td>
                  <td>{ossBucketLabel(shop, shops)}</td>
                  <td>{ossStatusLabel(shop)}</td>
                  <td>
                    <button className="secondary-button" onClick={async () => {
                      try {
                        const url = await api.testOssUpload(shop.id);
                        setMessage(`OSS 测试上传成功：${url}`);
                      } catch (error) {
                        setMessage(`OSS 测试上传失败：${error}`);
                      }
                    }}>测试上传</button>
                  </td>
                </tr>
              ))}
              {shops.length === 0 ? <tr><td colSpan={4} className="muted">暂无店铺。</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section> : null}

    </div>
  );
}

function shopRoleLabel(shop: Shop): string {
  return (shop.shopRole ?? "main") === "follower" ? "跟卖店铺" : "主店";
}

function ossBucketLabel(shop: Shop, shops: Shop[]): string {
  if ((shop.shopRole ?? "main") === "follower" && shop.followsShopId) {
    const mainName = shops.find((item) => item.id === shop.followsShopId)?.name ?? shop.followsShopId;
    return `复用 ${mainName}`;
  }
  return shop.ossBucket || "-";
}

function ossStatusLabel(shop: Shop): string {
  if ((shop.shopRole ?? "main") === "follower" && shop.followsShopId) {
    return "复用主店";
  }
  return shop.ossAccessKeyStored ? "Secret 已保存" : "Secret 未保存";
}
