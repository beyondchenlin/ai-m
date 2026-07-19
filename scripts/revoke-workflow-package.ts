import { revokeWorkflowPackage } from "@/lib/generation/workflows";

const digest = process.env.WORKFLOW_DIGEST?.trim();
const confirmation = process.env.CONFIRM_WORKFLOW_DIGEST?.trim();
const actorId = process.env.WORKFLOW_REVOKER_ID?.trim();
const reason = process.env.WORKFLOW_REVOCATION_REASON?.trim();

if (!digest || confirmation !== digest) {
  throw new Error("WORKFLOW_DIGEST and identical CONFIRM_WORKFLOW_DIGEST are required");
}
if (!actorId) throw new Error("WORKFLOW_REVOKER_ID is required");
if (!reason) throw new Error("WORKFLOW_REVOCATION_REASON is required");

console.log(JSON.stringify({
  digest,
  ...revokeWorkflowPackage({ workflowPackageDigest: digest, actorId, reason }),
}, null, 2));
