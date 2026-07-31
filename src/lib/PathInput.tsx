import { FolderOpen, FileSearch } from "lucide-react";
import { api } from "./api";

const isTauri = "__TAURI_INTERNALS__" in window;

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mode?: "dir" | "file" | "any";
}

async function pickDirectory(): Promise<string | null> {
  try {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string | null>("pick_directory");
    }
    return await api.pickDirectory();
  } catch {
    return null;
  }
}

async function pickFile(): Promise<string | null> {
  try {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string | null>("pick_file");
    }
    return await api.pickFile();
  } catch {
    return null;
  }
}

export function PathInput({ value, onChange, placeholder, mode = "dir" }: Props) {
  const label = mode === "dir" ? "选择目录" : mode === "file" ? "选择文件" : "选择文件/目录";

  const browse = async () => {
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
      <button className="icon-button" type="button" title={label} onClick={browse}>
        {mode === "file" ? <FileSearch size={16} /> : <FolderOpen size={16} />}
      </button>
    </div>
  );
}
