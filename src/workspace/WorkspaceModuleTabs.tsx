import { moduleForPage, type PageKey } from "./navigation";
import { canAccessPage } from "./featurePermissions";
import { useFeatures } from "../lib/featuresContext";

type Props = {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
};

export function WorkspaceModuleTabs({ page, onNavigate }: Props) {
  const { features } = useFeatures();
  const module = moduleForPage(page);

  // 过滤掉用户无权访问的页面
  const visiblePages = module.pages.filter((item) => canAccessPage(features, item.key));

  if (visiblePages.length < 2) {
    return null;
  }

  return (
    <nav className="tabs workspace-module-tabs" aria-label={`${module.label}页面`} role="tablist">
      {visiblePages.map((item) => (
        <button
          type="button"
          role="tab"
          aria-selected={item.key === page}
          className={item.key === page ? "tab active" : "tab"}
          key={item.key}
          onClick={() => onNavigate(item.key)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
