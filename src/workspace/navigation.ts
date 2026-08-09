export type PageKey =
  | 'dashboard'
  | 'materialPortrait'
  | 'materialAiImage'
  | 'materialTitle'
  | 'materialRename'
  | 'ozon'
  | 'autoListingPlans'
  | 'orders'
  | 'jobs'
  | 'imageUpload'
  | 'imagePending'
  | 'imageProcessing'
  | 'imageUploaded'
  | 'imageFeatured'
  | 'license'
  | 'adminUsers'
  | 'adminFeatures'
  | 'adminLogs';

export type WorkspaceModuleKey = 'home' | 'assets' | 'listing' | 'orders' | 'tasks';

export type WorkspacePage = {
  key: PageKey;
  label: string;
};

export type WorkspaceModule = {
  key: WorkspaceModuleKey;
  label: string;
  pages: readonly WorkspacePage[];
};

export const workspaceModules: readonly WorkspaceModule[] = [
  {
    key: 'home',
    label: '首页',
    pages: [{ key: 'dashboard', label: '首页' }],
  },
  {
    key: 'assets',
    label: '素材',
    pages: [
      { key: 'materialPortrait', label: '转 3:4 水印' },
      { key: 'materialAiImage', label: 'GPT 图片生成' },
      { key: 'materialTitle', label: 'AI 生成标题' },
      { key: 'materialRename', label: '图片重命名' },
      { key: 'imageUpload', label: '图片上传' },
      { key: 'imagePending', label: '待上传图片' },
      { key: 'imageProcessing', label: '上传中' },
      { key: 'imageUploaded', label: '已上传图片' },
      { key: 'imageFeatured', label: '精品图库' },
    ],
  },
  {
    key: 'listing',
    label: '上架',
    pages: [
      { key: 'ozon', label: '店铺管理' },
      { key: 'autoListingPlans', label: '自动上品方案' },
    ],
  },
  {
    key: 'orders',
    label: '订单',
    pages: [{ key: 'orders', label: '订单查询' }],
  },
  {
    key: 'tasks',
    label: '任务/设置',
    pages: [
      { key: 'jobs', label: '任务记录' },
      { key: 'license', label: '兑换密钥' },
      // 管理页面仅 admin 可见，通过 featurePermissions 过滤
      { key: 'adminUsers', label: '用户管理' },
      { key: 'adminFeatures', label: '功能开关' },
      { key: 'adminLogs', label: '操作日志' },
    ],
  },
];

export function moduleForPage(page: PageKey): WorkspaceModule {
  return workspaceModules.find((module) => module.pages.some((item) => item.key === page))!;
}
