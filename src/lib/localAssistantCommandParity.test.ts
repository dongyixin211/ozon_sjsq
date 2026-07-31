import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function commandNames(source: string, pattern: RegExp) {
  return Array.from(source.matchAll(pattern), (match) => match[1]).sort();
}

describe("local assistant command bridge", () => {
  it("exposes every registered Tauri business command to the browser workspace", () => {
    const root = process.cwd();
    const registeredSource = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
    const bridgeSource = readFileSync(join(root, "src-tauri", "src", "core", "local_assistant.rs"), "utf8");
    const registered = commandNames(registeredSource, /core::commands::([a-zA-Z0-9_]+)/g);
    const bridged = new Set(commandNames(bridgeSource, /"([a-zA-Z0-9_]+)"\s*=>/g));

    expect(registered.filter((command) => !bridged.has(command))).toEqual([]);
  });
});