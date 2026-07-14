import type { CompiledOutput } from "@/lib/generation/workflows/types";

export interface CollectedArtifactCandidate {
  artifactId: string;
  nodeId: string;
  outputKey: string;
  field: string;
  sequence: number;
}

/**
 * Select the job's canonical artifact using the reviewed workflow output order.
 *
 * Completion time is deliberately ignored: parallel downloads and filesystem
 * latency must never change which output is projected back to the business
 * entity. Every collected artifact must match an approved compiled output.
 */
export function selectPrimaryArtifact(
  candidates: CollectedArtifactCandidate[],
  approvedOutputs: CompiledOutput[],
): CollectedArtifactCandidate {
  if (candidates.length === 0) {
    throw new Error("Execution produced no committed artifact");
  }

  const priorities = new Map<string, number>();
  approvedOutputs.forEach((output, index) => {
    priorities.set(`${output.key}\u0000${output.nodeId}\u0000${output.field}`, index);
  });

  const ranked = candidates.map((candidate) => {
    const priority = priorities.get(
      `${candidate.outputKey}\u0000${candidate.nodeId}\u0000${candidate.field}`,
    );
    if (priority === undefined) {
      throw new Error(
        `Committed artifact does not match an approved workflow output: ${candidate.outputKey}`,
      );
    }
    return { candidate, priority };
  });

  ranked.sort((left, right) =>
    left.priority - right.priority || left.candidate.sequence - right.candidate.sequence,
  );
  return ranked[0].candidate;
}
