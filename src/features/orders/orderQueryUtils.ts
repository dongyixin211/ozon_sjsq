import type { StoredOrderQuery } from "@shared/types";

interface ResolveStoredOrderQueryInput {
  currentStatus: string;
  status?: string;
  shopIds: string[];
  keyword: string;
  limit: number;
}

export function resolveStoredOrderQuery(input: ResolveStoredOrderQueryInput): StoredOrderQuery {
  const status = Object.prototype.hasOwnProperty.call(input, "status")
    ? input.status
    : input.currentStatus;

  return {
    shopIds: input.shopIds,
    status: status?.trim() || undefined,
    keyword: input.keyword.trim() || undefined,
    limit: input.limit,
  };
}

export function isLatestOrderRequest(requestId: number, latestId: number) {
  return requestId === latestId;
}
