/** Application-owned administration commands; RPC schemas are checked separately. */
export type AdminFlagsPatch = { is_active?: boolean; is_admin?: boolean };
export type AdminDeleteResult = { notFound: true } | { forbiddenAdmin: true } | { taskId: number; jobId: string };
