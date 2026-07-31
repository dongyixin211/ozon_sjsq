import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "src/public/admin.html"), "utf8");

const checks = [
  ["uses refreshed blue-white admin shell", html.includes("--color-primary") && html.includes("--color-surface")],
  ["shows bulk copy unused license button", html.includes('id="copyUnusedKeys"') && html.includes("复制本页未使用授权码")],
  ["stores latest visible license keys", html.includes("state.keys.visible")],
  ["implements bulk unused license copy", html.includes("async function copyUnusedLicenseKeys")],
  ["delete license buttons are explicit buttons", html.includes('type="button" data-delete-license')],
  ["delete license disables button while deleting", html.includes('deleteButton.disabled = true') && html.includes('deleteButton.textContent = "删除中..."')],
  ["delete license calls DELETE route", html.includes('method: "DELETE"') && html.includes("/admin/license-keys/")],
];

const failures = checks.filter(([, passed]) => !passed);

if (failures.length) {
  console.error("Admin static verification failed:");
  for (const [name] of failures) console.error(`- ${name}`);
  process.exit(1);
}

console.log(`Admin static verification passed (${checks.length} checks)`);
