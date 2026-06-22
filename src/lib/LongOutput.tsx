import { useState, type CSSProperties } from "react";

interface Props {
  value: string;
  emptyText: string;
  label?: string;
  maxHeight?: number;
  defaultExpanded?: boolean;
  onClear?: () => void;
}

export function LongOutput({
  value,
  emptyText,
  label,
  maxHeight = 180,
  defaultExpanded = false,
  onClear,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copyStatus, setCopyStatus] = useState("");
  const hasValue = value.trim().length > 0;

  const copy = async () => {
    if (!hasValue) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败");
    }
  };

  return (
    <div className="long-output" style={{ "--long-output-max-height": `${maxHeight}px` } as CSSProperties}>
      <div className="long-output-toolbar">
        {label ? <strong>{label}</strong> : <span />}
        <div className="toolbar">
          {copyStatus ? <span className="muted">{copyStatus}</span> : null}
          <button className="secondary-button" disabled={!hasValue} onClick={copy}>复制</button>
          {onClear ? <button className="secondary-button" disabled={!hasValue} onClick={onClear}>清空</button> : null}
          <button className="secondary-button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起" : "展开"}
          </button>
        </div>
      </div>
      <pre className={expanded ? "log-box long-output-box expanded" : "log-box long-output-box"}>{hasValue ? value : emptyText}</pre>
    </div>
  );
}
