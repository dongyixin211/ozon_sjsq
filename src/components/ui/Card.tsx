/**
 * components/ui/Card.tsx — 卡片容器组件
 *
 * 变体: panel (白底面板) | listItem (列表行) | stat (统计数字)
 * 全部使用 tokens.css 设计令牌。
 */
import React from "react";

export type CardVariant = "panel" | "listItem" | "stat";

export interface CardProps {
  variant?: CardVariant;
  title?: React.ReactNode;
  subtitle?: string;
  extra?: React.ReactNode;
  footer?: React.ReactNode;
  /** stat variant 的数值 */
  value?: string | number;
  /** stat variant 的趋势箭头 */
  trend?: "up" | "down" | "flat";
  hoverable?: boolean;
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

const variantClass: Record<CardVariant, string> = {
  panel: "ui-card-panel",
  listItem: "ui-card-list-item",
  stat: "ui-card-stat",
};

export const Card: React.FC<CardProps> = ({
  variant = "panel",
  title,
  subtitle,
  extra,
  footer,
  value,
  trend,
  hoverable = false,
  children,
  className,
  onClick,
}) => {
  const cls = [
    "ui-card",
    variantClass[variant],
    hoverable ? "ui-card-hoverable" : "",
    onClick ? "ui-card-clickable" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}>
      {(title || extra) && (
        <div className="ui-card-header">
          <div className="ui-card-title-wrap">
            {title && <h3 className="ui-card-title">{title}</h3>}
            {subtitle && <span className="ui-card-subtitle">{subtitle}</span>}
          </div>
          {extra && <div className="ui-card-extra">{extra}</div>}
        </div>
      )}

      {variant === "stat" ? (
        <div className="ui-card-stat-body">
          <span className="ui-card-stat-value">{value}</span>
          {trend && (
            <span className={`ui-card-stat-trend ui-card-stat-trend-${trend}`}>
              {trend === "up" ? "↑" : trend === "down" ? "↓" : "→"}
            </span>
          )}
        </div>
      ) : (
        children && <div className="ui-card-body">{children}</div>
      )}

      {footer && <div className="ui-card-footer">{footer}</div>}
    </div>
  );
};
