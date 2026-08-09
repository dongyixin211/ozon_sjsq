// @ts-nocheck — bullmq is a Phase 3 dependency, not yet installed
/**
 * infrastructure/queue/connection.ts — BullMQ 任务队列连接
 *
 * Phase 3: 引入 BullMQ，替代进程内 Map/Set 任务管理。
 * Phase 1: 占位。
 */

import type { Queue, Worker, Job, JobsOptions } from "bullmq";

export interface TaskQueue {
  add(name: string, data: Record<string, unknown>, opts?: JobsOptions): Promise<Job>;
  getJob(jobId: string): Promise<Job | null>;
  close(): Promise<void>;
}

/** Phase 3: 创建 BullMQ 连接 */
export async function createTaskQueue(name: string): Promise<TaskQueue> {
  // TODO: import { Queue } from "bullmq"
  throw new Error(`Task queue "${name}" not yet implemented — Phase 3`);
}
