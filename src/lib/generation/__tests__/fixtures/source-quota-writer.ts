import { reserveSourceAssetQuota } from "../../source-assets";

const [projectId, userId, bytes] = process.argv.slice(2);
if (!projectId || !userId || !bytes) process.exit(2);

try {
  const reservation = reserveSourceAssetQuota(projectId, userId, Number(bytes));
  process.stdout.write(JSON.stringify({ accepted: true, id: reservation.id }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    accepted: false,
    code: error && typeof error === "object" && "code" in error ? error.code : "unknown",
  }));
}
