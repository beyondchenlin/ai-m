import { OperationsAttentionClient } from "./operations-attention-client";
import { OperationalHealthClient } from "./operational-health-client";

export default function OperationsPage() {
  return (
    <>
      <div className="bg-[#f2f1ec] px-5 pt-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <OperationalHealthClient />
        </div>
      </div>
      <OperationsAttentionClient />
    </>
  );
}
