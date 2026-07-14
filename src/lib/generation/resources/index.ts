export {
  LEASE_CONFIG,
  acquireResourceSlot,
  renewResourceSlot,
  releaseResourceSlot,
  recordResourceTerminationProof,
  claimJob,
  renewJobClaim,
  releaseJobClaim,
  scanExpiredClaims,
} from "./leases";
export type { ResourceTerminationProofInput } from "./leases";
