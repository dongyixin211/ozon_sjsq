import { moduleForPage, type PageKey } from "./navigation";

type Props = {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
};

export function WorkspaceModuleTabs({ page, onNavigate }: Props) {
  const module = moduleForPage(page);
  if (module.pages.length < 2) {
    return null;
  }

  return (
    <nav className="tabs workspace-module-tabs" aria-label={`${module.label}页面`} role="tablist">
      {module.pages.map((item) => (
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
