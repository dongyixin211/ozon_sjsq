/**
 * components/ui/Badge.tsx — 状态标签组件
 *
 * 语义: success | warning | error | info | neutral
 * 全部使用 tokens.css 设计令牌的语义色。
 */
import React from "react";

export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

export interface BadgeProps {
  variant?: BadgeVariant;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}

const variantClass: Record<BadgeVariant, string> = {
  success: "ui-badge-success",
  warning: "ui-badge-warning",
  error: "ui-badge-error",
  info: "ui-badge-info",
  neutral: "ui-badge-neutral",
};

export const Badge: React.FC<BadgeProps> = ({
  variant = "neutral",
  dot = false,
  children,
  className,
}) => {
  return (
    <span className={`ui-badge ${variantClass[variant]} ${className ?? ""}`}>
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
};
