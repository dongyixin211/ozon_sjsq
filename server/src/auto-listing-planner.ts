export interface PlannerQuota {
  createRemaining: number;
  totalRemaining: number;
}

export const DEFAULT_AUTO_LISTING_DAILY_TARGET = 100;

export interface AllocationShop {
  externalShopId: string;
  capacity: number;
  outstanding?: number;
}

export interface AssetAllocation {
  assetId: string;
  externalShopId: string;
}

export type ReleasableAssignmentStatus =
  | "reserved"
  | "preparing"
  | "ready"
  | "submitting"
  | "completed"
  | "failed"
  | "paused"
  | "released";

export interface ReleasableAssignment {
  status: ReleasableAssignmentStatus;
  batchId?: string | null;
  hasGeneratedWork: boolean;
}

export interface AutoListingPlanValidationInput {
  startMinute: number;
  endMinute: number;
  batchSize: number;
  bufferSize: number;
  enabled: boolean;
  externalShopIds: string[];
}

export function calculateSafeCreateCount(
  quota: PlannerQuota,
  availableAssets: number,
  safetyReservePercent = 0,
) {
  if (quota.createRemaining <= 0 || quota.totalRemaining <= 0 || availableAssets <= 0) {
    return 0;
  }
  const reserve = Math.min(
    quota.createRemaining,
    Math.max(0, Math.ceil(quota.createRemaining * Math.max(0, safetyReservePercent))),
  );
  return Math.max(0, Math.min(
    quota.createRemaining - reserve,
    quota.totalRemaining,
    availableAssets,
  ));
}

export function calculateRemainingShopCapacity(
  quota: PlannerQuota,
  dailyTarget: number,
  completedToday: number,
  outstandingAssignments: number,
  reservationWindow: number,
  safetyReservePercent = 0,
) {
  const dailyRemaining = Math.max(
    0,
    Math.floor(dailyTarget) - Math.max(0, Math.floor(completedToday)) - Math.max(0, Math.floor(outstandingAssignments)),
  );
  return Math.max(
    0,
    Math.min(
      dailyRemaining,
      calculateSafeCreateCount(quota, reservationWindow, safetyReservePercent),
    ),
  );
}

export function calculateAvailableReservationSlots(
  shops: AllocationShop[],
  perShopWindow: number,
) {
  const window = Math.max(0, Math.floor(perShopWindow));
  return shops.reduce((total, shop) => {
    const capacity = Math.max(0, Math.floor(shop.capacity));
    const outstanding = Math.max(0, Math.floor(shop.outstanding ?? 0));
    return total + Math.min(capacity, Math.max(0, window - outstanding));
  }, 0);
}

export function calculateReservationCapacityByShop(
  shops: AllocationShop[],
  perShopWindow: number,
) {
  const window = Math.max(0, Math.floor(perShopWindow));
  return shops.map((shop) => {
    const capacity = Math.max(0, Math.floor(shop.capacity));
    const outstanding = Math.max(0, Math.floor(shop.outstanding ?? 0));
    return {
      externalShopId: shop.externalShopId,
      capacity: Math.min(capacity, Math.max(0, window - outstanding)),
      outstanding,
    };
  });
}


export function allocateRoundRobin(shops: AllocationShop[], assetIds: string[]): AssetAllocation[] {
  if (new Set(assetIds).size !== assetIds.length) {
    throw new Error("Duplicate asset ID in allocation request");
  }

  const remaining = shops.map((shop, index) => ({
    externalShopId: shop.externalShopId,
    capacity: Math.max(0, Math.floor(shop.capacity)),
    load: Math.max(0, Math.floor(shop.outstanding ?? 0)),
    index,
  }));
  const allocations: AssetAllocation[] = [];

  for (const assetId of assetIds) {
    const shop = remaining
      .filter((item) => item.capacity > 0)
      .sort((left, right) => left.load - right.load || left.index - right.index)[0];
    if (!shop) break;
    allocations.push({ assetId, externalShopId: shop.externalShopId });
    shop.capacity -= 1;
    shop.load += 1;
  }

  return allocations;
}

export function shouldReleaseFailedAssignment(status: ReleasableAssignmentStatus, retryCount: number) {
  return status === "failed" && Number.isInteger(retryCount) && retryCount >= 3;
}

export function canReleaseAssignment(assignment: ReleasableAssignment) {
  return assignment.status === "reserved"
    && !assignment.batchId
    && !assignment.hasGeneratedWork;
}

export type AutoListingLaunchShop = {
  externalShopId: string;
  shopName: string;
};

export type AutoListingLaunchQuota = {
  dailyCreateRemaining: number;
  totalRemaining: number;
};

export type AutoListingLaunchIssue = {
  externalShopId: string;
  shopName: string;
  reason: "quota_missing" | "quota_invalid";
};

export function validateAutoListingLaunch(
  shops: AutoListingLaunchShop[],
  quotaByExternalShopId: Record<string, AutoListingLaunchQuota>,
) {
  const issues: AutoListingLaunchIssue[] = [];
  for (const shop of shops) {
    const quota = quotaByExternalShopId[shop.externalShopId];
    if (!quota) {
      issues.push({ externalShopId: shop.externalShopId, shopName: shop.shopName, reason: "quota_missing" });
    } else if (quota.dailyCreateRemaining < 0 || quota.totalRemaining < 0) {
      issues.push({ externalShopId: shop.externalShopId, shopName: shop.shopName, reason: "quota_invalid" });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateAutoListingPlan(
  plan: AutoListingPlanValidationInput,
  hasEnabledPlanForProductRule: boolean,
) {
  if (!Number.isInteger(plan.startMinute) || !Number.isInteger(plan.endMinute)
    || plan.startMinute < 0 || plan.endMinute > 1440 || plan.startMinute >= plan.endMinute) {
    throw new Error("Execution window start must be earlier than end");
  }
  if (!Number.isInteger(plan.batchSize) || plan.batchSize < 5 || plan.batchSize > 20) {
    throw new Error("Batch size must be between 5 and 20");
  }
  if (!Number.isInteger(plan.bufferSize) || plan.bufferSize < 0 || plan.bufferSize > plan.batchSize * 2) {
    throw new Error("Buffer size cannot exceed two batches");
  }
  if (new Set(plan.externalShopIds).size !== plan.externalShopIds.length) {
    throw new Error("Duplicate shop in plan");
  }
  if (plan.enabled && plan.externalShopIds.length === 0) {
    throw new Error("Enabled plan must include at least one shop");
  }
  if (plan.enabled && hasEnabledPlanForProductRule) {
    throw new Error("An enabled plan already exists for this product rule");
  }
}

const assignmentStatusTransitions: Record<ReleasableAssignmentStatus, ReleasableAssignmentStatus[]> = {
  reserved: ["preparing", "failed", "paused"],
  preparing: ["ready", "failed", "paused"],
  ready: ["submitting", "failed", "paused"],
  submitting: ["completed", "failed", "paused"],
  completed: [],
  failed: ["preparing", "paused"],
  paused: ["preparing", "ready", "submitting", "failed"],
  released: [],
};

export function assertAssignmentStatusTransition(
  currentStatus: ReleasableAssignmentStatus,
  nextStatus: ReleasableAssignmentStatus,
) {
  if (currentStatus === nextStatus) return;
  if (!assignmentStatusTransitions[currentStatus].includes(nextStatus)) {
    throw new Error(`Invalid assignment status transition: ${currentStatus} -> ${nextStatus}`);
  }
}

export function assertAssignmentBatchUpdate(currentBatchId: string | null, nextBatchId: string | null) {
  if (currentBatchId && nextBatchId !== currentBatchId) {
    throw new Error("Assignment batch cannot be cleared or replaced");
  }
}




