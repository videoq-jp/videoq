/** Source, physical run and active embedding identity must all match readiness. */
export const CURRENT_POLICY_READINESS = `SELECT p.*,
 CASE WHEN (? IS NULL OR p.ready_fingerprint=?) AND (? IS NULL OR p.ready_dimensions=?)
 AND EXISTS(SELECT 1 FROM video_index_heads h JOIN scene_index_runs r ON r.id=h.run_id
 WHERE h.video_id=p.video_id AND h.dimensions=p.ready_dimensions AND h.run_id=p.ready_run_id
 AND r.source_revision=p.source_revision AND r.status='published' AND r.embedding_fingerprint=p.ready_fingerprint)
 THEN p.ready_at ELSE NULL END AS observed_ready_at
 FROM policy_readiness p JOIN video_index_versions v ON v.video_id=p.video_id AND v.revision=p.source_revision`;
