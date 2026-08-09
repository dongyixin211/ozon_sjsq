/**
 * core/config.ts — 应用配置
 *
 * 当前从 server/src/config.ts 透传，后续直接迁移 Zod schema。
 * 目标：所有模块只 import 此文件，不直接引用 process.env。
 */
export { config, planRules } from "../config.js";
export type { PlanCode } from "../config.js";
