/**
 * components/ui/Button.tsx — 通用按钮组件
 *
 * 变体: primary | secondary | danger | text
 * 尺寸: sm | md | lg
 * 全部使用 tokens.css 设计令牌，零硬编码色值。
 */
import React from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "text";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: "ui-btn-primary",
  secondary: "ui-btn-secondary",
  danger: "ui-btn-danger",
  text: "ui-btn-text",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "ui-btn-sm",
  md: "ui-btn-md",
  lg: "ui-btn-lg",
};

export const Button: React.FC<ButtonProps> = ({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  disabled,
  className,
  ...rest
}) => {
  const cls = [
    "ui-btn",
    variantClass[variant],
    sizeClass[size],
    loading ? "ui-btn-loading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="ui-btn-spinner" aria-hidden="true" />}
      {icon && !loading && <span className="ui-btn-icon">{icon}</span>}
      {children && <span className="ui-btn-label">{children}</span>}
    </button>
  );
};
