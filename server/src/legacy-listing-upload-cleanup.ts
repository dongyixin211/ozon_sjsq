export const LEGACY_LISTING_UPLOAD_RETENTION_DAYS = 1;

export type LegacyListingCleanupCandidate = {
  userId: string;
  objectKey: string;
  sizeBytes: number;
  createdAt: Date;
  hasActiveGrant: boolean;
};

export function isLegacyListingObjectKey(objectKey: string, userId: string) {
  return objectKey.startsWith(`legacy-listing/${userId}/`)
    && !objectKey.includes("..")
    && !objectKey.includes("\\");
}

export function isEligibleLegacyListingUpload(
  candidate: LegacyListingCleanupCandidate,
  now: Date,
  retentionDays = LEGACY_LISTING_UPLOAD_RETENTION_DAYS,
) {
  if (candidate.hasActiveGrant) return false;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return candidate.createdAt.getTime() < cutoff;
}

export function summarizeLegacyListingCleanup(
  candidates: LegacyListingCleanupCandidate[],
  now: Date,
  retentionDays = LEGACY_LISTING_UPLOAD_RETENTION_DAYS,
) {
  const eligible = candidates.filter((candidate) => isEligibleLegacyListingUpload(candidate, now, retentionDays));
  const protectedCount = candidates.length - eligible.length;
  return {
    eligible,
    protectedCount,
    eligibleBytes: eligible.reduce((total, candidate) => total + candidate.sizeBytes, 0),
  };
}
