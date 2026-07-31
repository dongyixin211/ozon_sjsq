export function formatDate(value: string | undefined): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function statusText(status: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

export function jobKindText(kind: string): string {
  const labels: Record<string, string> = {
    materials: "素材生成",
    scene_local: "本地场景",
    scene_ai: "AI 场景",
    local_mockup: "本地后台套图",
    auto_listing: "云图库自动上架",
    gallery_upload: "云图库图片上传",
    batch_upload: "批量上架",
    listing_image_repair: "历史图片修复",
    listed_update: "商品更新",
    follow_sync: "跟卖同步",
    follow_automation: "跟卖自动化",
    inventory: "库存",
    barcode: "条码",
    order_documents: "订单文件",
    api_test: "接口测试",
  };
  return labels[kind] ?? kind;
}
