export type JobClaim =
  | { status: "claimed"; leaseToken: string }
  | { status: "completed" | "busy" | "conflict" };

export interface JobRepository {
  claim(input: { jobId: string; jobType: string; payloadSha256: string }): Promise<JobClaim>;
  complete(jobId: string, leaseToken: string): Promise<boolean>;
  fail(jobId: string, leaseToken: string, errorCode: string): Promise<boolean>;
  heartbeat(jobId: string, leaseToken: string): Promise<boolean>;
}

export function validateJobIdentity(input: { jobId: string; jobType: string; payloadSha256: string }): void {
  if (!input.jobId.length || input.jobId.length > 128 || !input.jobType.length || input.jobType.length > 64 ||
      !/^[a-f0-9]{64}$/.test(input.payloadSha256)) throw new Error("Invalid job identity");
}

export const JOB_LEASE_SECONDS = 900;
