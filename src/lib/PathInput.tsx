import { FolderOpen, FileSearch } from "lucide-react";

const isTauri = "__TAURI_INTERNALS__" in window;

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mode?: "dir" | "file" | "any";
}

async function pickDirectory(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<string | null>("pick_directory");
    return result;
  } catch {
    return null;
  }
}

async function pickFile(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<string | null>("pick_file");
    return result;
  } catch {
    return null;
  }
}

export function PathInput({ value, onChange, placeholder, mode = "dir" }: Props) {
  const label = mode === "dir" ? "选择目录" : mode === "file" ? "选择文件" : "选择文件/目录";

  const browse = async () => {
    if (!isTauri) {
      alert("目录选择功能需要在 Tauri 桌面应用中运行。\n当前为浏览器预览模式，请手动输入路径。");
      return;
    }
    try {
      const result = mode === "dir" ? await pickDirectory() : await pickFile();
      if (result) {
        onChange(result);
      }
    } catch (error) {
      console.warn("文件对话框错误:", error);
    }
  };

  return (
    <div className="path-input-group">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? `/path/to/${mode === "dir" ? "folder" : "file"}`}
      />
      {isTauri ? (
        <button className="icon-button" type="button" title={label} onClick={browse}>
          {mode === "file" ? <FileSearch size={16} /> : <FolderOpen size={16} />}
        </button>
      ) : (
        <button className="icon-button muted-button" type="button" title="仅 Tauri 桌面端可用" onClick={browse}>
          <FolderOpen size={16} />
        </button>
      )}
    </div>
  );
}
