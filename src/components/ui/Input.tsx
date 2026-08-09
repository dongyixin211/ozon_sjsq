/**
 * components/ui/Input.tsx — 通用输入框组件
 *
 * 类型: text | password | search | number
 * 状态: disabled | error | readOnly
 * 全部使用 tokens.css 设计令牌。
 */
import React from "react";

export type InputType = "text" | "password" | "search" | "number";

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  type?: InputType;
  label?: string;
  hint?: string;
  error?: string;
  prepend?: React.ReactNode;
  append?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({
  type = "text",
  label,
  hint,
  error,
  prepend,
  append,
  className,
  id,
  ...rest
}) => {
  const inputId = id ?? (label ? `input-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);

  return (
    <div className={`ui-input-group ${error ? "ui-input-error" : ""} ${className ?? ""}`}>
      {label && (
        <label htmlFor={inputId} className="ui-input-label">
          {label}
        </label>
      )}
      <div className="ui-input-wrap">
        {prepend && <span className="ui-input-prepend">{prepend}</span>}
        <input
          id={inputId}
          type={type}
          className="ui-input"
          aria-invalid={error ? "true" : undefined}
          {...rest}
        />
        {append && <span className="ui-input-append">{append}</span>}
      </div>
      {error && <span className="ui-input-error-text">{error}</span>}
      {hint && !error && <span className="ui-input-hint">{hint}</span>}
    </div>
  );
};
