/**
 * components/ui/Alert.tsx — 提示横幅组件
 *
 * 语义: success | warning | error | info
 * 支持可关闭、带标题、带操作按钮。
 * 全部使用 tokens.css 设计令牌的语义色。
 */
import React, { useState } from "react";
import { Button } from "./Button";

export type AlertVariant = "success" | "warning" | "error" | "info";

export interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  message: string;
  closable?: boolean;
  action?: { label: string; onClick: () => void };
  className?: string;
}

const variantClass: Record<AlertVariant, string> = {
  success: "ui-alert-success",
  warning: "ui-alert-warning",
  error: "ui-alert-error",
  info: "ui-alert-info",
};

const variantIcon: Record<AlertVariant, string> = {
  success: "✓",
  warning: "⚠",
  error: "✕",
  info: "ℹ",
};

export const Alert: React.FC<AlertProps> = ({
  variant = "info",
  title,
  message,
  closable = false,
  action,
  className,
}) => {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div
      className={`ui-alert ${variantClass[variant]} ${className ?? ""}`}
      role="alert"
    >
      <span className="ui-alert-icon" aria-hidden="true">
        {variantIcon[variant]}
      </span>
      <div className="ui-alert-content">
        {title && <strong className="ui-alert-title">{title}</strong>}
        <span className="ui-alert-message">{message}</span>
        {action && (
          <span className="ui-alert-action">
            <Button variant="text" size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          </span>
        )}
      </div>
      {closable && (
        <button
          className="ui-alert-close"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
        >
          ×
        </button>
      )}
    </div>
  );
};
