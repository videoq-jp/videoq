-- Apply through the administration connection, never from an application role.
-- Existing schema owner remains stable when its LOGIN is retired.
DO $roles$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['videoq_api_access','videoq_worker_access','videoq_backup_access',
    'videoq_audit_access','videoq_smoke_access','videoq_demo_access'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', name);
    END IF;
  END LOOP;
END $roles$;
GRANT videoq_worker_20261014 TO videoq_worker_access;
CREATE SCHEMA IF NOT EXISTS videoq_security AUTHORIZATION videoq_migrate_20260918;
SET ROLE videoq_migrate_20260918;
GRANT USAGE ON SCHEMA public TO videoq_api_access, videoq_worker_access, videoq_backup_access;
GRANT USAGE ON SCHEMA drizzle TO videoq_backup_access;
GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO videoq_backup_access;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO videoq_backup_access;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, drizzle GRANT SELECT ON TABLES TO videoq_backup_access;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, drizzle GRANT SELECT ON SEQUENCES TO videoq_backup_access;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO videoq_api_access;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO videoq_api_access;
DO $grants$
DECLARE name text; seq text;
BEGIN
  -- Retired Django/OAuth tables are deliberately excluded from the API role.
  FOREACH name IN ARRAY ARRAY['runtime_rate_limits','users','account_deletion_requests','external_tasks',
    'job_executions','mcp_idempotency_records','videos','video_transcription_runs','video_transcription_chunks',
    'video_visual_runs','video_visual_chunks','video_courses','video_course_members','video_course_invitations',
    'video_course_memberships','tags','video_tags','chat_logs','ai_answer_attempts','chat_log_evaluations',
    'course_evaluation_snapshots','scene_embeddings','scene_embeddings_768','stripe_events',
    'session','account','verification','apikey','jwks','device_code','oauth_client','oauth_resource',
    'oauth_client_resource','oauth_refresh_token','oauth_access_token','oauth_consent','oauth_client_assertion'] LOOP
    IF to_regclass('public.' || name) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO videoq_api_access', name);
      FOR seq IN SELECT pg_get_serial_sequence('public.' || name, a.attname)
        FROM pg_attribute a WHERE a.attrelid=to_regclass('public.' || name)
        AND a.attnum>0 AND NOT a.attisdropped LOOP
        IF seq IS NOT NULL THEN EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO videoq_api_access', seq); END IF;
      END LOOP;
    END IF;
  END LOOP;
END $grants$;
GRANT SELECT (transcription_language) ON public.videos TO videoq_worker_access;
-- New embedding tables were added after the pre-existing worker role was created.
GRANT SELECT, INSERT, DELETE ON public.scene_embeddings, public.scene_embeddings_768 TO videoq_worker_access;
REVOKE ALL ON SCHEMA videoq_security FROM PUBLIC;
GRANT USAGE ON SCHEMA videoq_security TO videoq_smoke_access, videoq_audit_access, videoq_demo_access, videoq_backup_access;
CREATE TABLE IF NOT EXISTS videoq_security.smoke_identities (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP VIEW IF EXISTS videoq_security.smoke_visual_runs, videoq_security.smoke_external_tasks,
  videoq_security.smoke_courses, videoq_security.smoke_scene_embeddings, videoq_security.smoke_chat_logs,
  videoq_security.smoke_videos, videoq_security.smoke_users, videoq_security.demo_courses,
  videoq_security.demo_videos, videoq_security.demo_scene_embeddings, videoq_security.demo_users;
CREATE OR REPLACE VIEW videoq_security.smoke_users WITH (security_barrier=true) AS
  SELECT id,username,email,name,role,quota_source,created_at,ai_answers_limit FROM public.users WHERE username='ops_smoke_' || id AND email=id || '@example.invalid'
    AND name='VideoQ automated smoke check' AND role='user' AND quota_source='admin'
    AND id IN(SELECT user_id FROM videoq_security.smoke_identities);
CREATE OR REPLACE VIEW videoq_security.smoke_videos WITH (security_barrier=true) AS
  SELECT v.id,v.user_id,v.status FROM public.videos v JOIN videoq_security.smoke_users u ON u.id=v.user_id;
CREATE OR REPLACE VIEW videoq_security.smoke_visual_runs WITH (security_barrier=true) AS
  SELECT r.video_id,r.status FROM public.video_visual_runs r JOIN videoq_security.smoke_videos v ON v.id=r.video_id;
CREATE OR REPLACE VIEW videoq_security.smoke_external_tasks WITH (security_barrier=true) AS
  SELECT t.kind,t.payload->>'user_id' AS user_id,t.completed_at FROM public.external_tasks t JOIN videoq_security.smoke_users u ON u.id=t.payload->>'user_id';
CREATE OR REPLACE VIEW videoq_security.smoke_courses WITH (security_barrier=true) AS
  SELECT c.id,c.user_id FROM public.video_courses c JOIN videoq_security.smoke_users u ON u.id=c.user_id;
CREATE OR REPLACE VIEW videoq_security.smoke_scene_embeddings WITH (security_barrier=true) AS
  SELECT e.user_id,e.video_id FROM public.scene_embeddings e JOIN videoq_security.smoke_users u ON u.id=e.user_id;
CREATE OR REPLACE VIEW videoq_security.smoke_chat_logs WITH (security_barrier=true) AS
  SELECT l.id,l.user_id FROM public.chat_logs l JOIN videoq_security.smoke_users u ON u.id=l.user_id;
CREATE OR REPLACE FUNCTION videoq_security.smoke_create(p_id uuid, p_hash text, p_ai boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF length(p_hash)<32 OR length(p_hash)>1024 THEN RAISE EXCEPTION 'INVALID_HASH'; END IF;
  INSERT INTO public.users(id,username,email,name,role,email_verified,password_reset_required,is_over_quota,
    used_ai_answers,used_processing_seconds,used_storage_bytes,quota_source,processing_limit_minutes,
    ai_answers_limit,storage_limit_gb,monthly_upload_limit_gb)
    VALUES(p_id::text,'ops_smoke_'||p_id::text,p_id::text||'@example.invalid','VideoQ automated smoke check',
      'user',true,false,false,0,0,0,'admin',1,CASE WHEN p_ai THEN 3 ELSE 0 END,0.01,0.01);
  INSERT INTO videoq_security.smoke_identities(user_id) VALUES(p_id::text);
  INSERT INTO public.account(id,account_id,provider_id,user_id,password)
    VALUES(gen_random_uuid()::text,p_id::text,'credential',p_id::text,p_hash);
END $$;
CREATE OR REPLACE FUNCTION videoq_security.smoke_password(p_id text, p_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF length(p_hash)<32 OR length(p_hash)>1024 OR NOT EXISTS
    (SELECT FROM videoq_security.smoke_users WHERE id=p_id) THEN RAISE EXCEPTION 'UNSAFE_SMOKE_IDENTITY'; END IF;
  UPDATE public.account SET password=p_hash WHERE user_id=p_id AND provider_id='credential';
END $$;
CREATE OR REPLACE FUNCTION videoq_security.smoke_expire(p_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM videoq_security.smoke_users WHERE id=p_id) THEN RAISE EXCEPTION 'UNSAFE_SMOKE_IDENTITY'; END IF;
  UPDATE public.session SET expires_at=LEAST(expires_at,now()+interval '1 hour') WHERE user_id=p_id;
END $$;
CREATE OR REPLACE FUNCTION videoq_security.smoke_delete(p_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT FROM videoq_security.smoke_users WHERE id=p_id) THEN RAISE EXCEPTION 'UNSAFE_SMOKE_IDENTITY'; END IF;
  IF EXISTS(SELECT FROM public.videos WHERE user_id=p_id) THEN RETURN false; END IF;
  DELETE FROM public.users WHERE id=p_id AND id IN(SELECT id FROM videoq_security.smoke_users);
  RETURN FOUND;
END $$;
CREATE OR REPLACE VIEW videoq_security.demo_users WITH (security_barrier=true) AS
  SELECT id,username,email,name,role,quota_source,is_over_quota,ai_answers_limit,used_ai_answers FROM public.users WHERE username='videoq_public_demo' OR email='public-demo@videoq.jp';
CREATE OR REPLACE VIEW videoq_security.demo_courses WITH (security_barrier=true) AS
  SELECT c.id,c.user_id,c.description,c.share_slug FROM public.video_courses c WHERE lower(share_slug)='videoq-campus-basics-v1'
    OR user_id IN(SELECT id FROM videoq_security.demo_users);
CREATE OR REPLACE VIEW videoq_security.demo_videos WITH (security_barrier=true) AS
  SELECT v.id,v.user_id,v.description FROM public.videos v WHERE user_id IN(SELECT id FROM videoq_security.demo_users);
CREATE OR REPLACE VIEW videoq_security.demo_scene_embeddings WITH (security_barrier=true) AS
  SELECT e.user_id,e.video_id FROM public.scene_embeddings e WHERE user_id IN(SELECT id FROM videoq_security.demo_users);
CREATE OR REPLACE FUNCTION videoq_security.demo_prepare(p_id uuid, p_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing record;
BEGIN
  IF length(p_hash)<32 OR length(p_hash)>1024 THEN RAISE EXCEPTION 'INVALID_HASH'; END IF;
  IF (SELECT count(*) FROM videoq_security.demo_users)>1 THEN RAISE EXCEPTION 'DEMO_OWNER_COLLISION'; END IF;
  SELECT * INTO existing FROM videoq_security.demo_users FOR UPDATE;
  IF FOUND THEN
    IF existing.id<>p_id::text OR existing.username IS DISTINCT FROM 'videoq_public_demo' OR existing.email IS DISTINCT FROM 'public-demo@videoq.jp'
      OR existing.name IS DISTINCT FROM 'VideoQ public demo' OR existing.role IS DISTINCT FROM 'user' OR existing.quota_source IS DISTINCT FROM 'admin'
      OR existing.is_over_quota IS DISTINCT FROM false THEN RAISE EXCEPTION 'DEMO_OWNER_IDENTITY_MISMATCH'; END IF;
    UPDATE public.users SET ai_answers_limit=100,processing_limit_minutes=20,storage_limit_gb=0.1,
      monthly_upload_limit_gb=0.1 WHERE id=existing.id;
    UPDATE public.account SET password=p_hash WHERE user_id=existing.id AND provider_id='credential';
    IF NOT FOUND THEN RAISE EXCEPTION 'DEMO_CREDENTIAL_ACCOUNT_MISMATCH'; END IF;
  ELSE
    INSERT INTO public.users(id,username,email,name,role,email_verified,password_reset_required,is_over_quota,
      used_ai_answers,used_processing_seconds,used_storage_bytes,quota_source,processing_limit_minutes,
      ai_answers_limit,storage_limit_gb,monthly_upload_limit_gb)
      VALUES(p_id::text,'videoq_public_demo','public-demo@videoq.jp','VideoQ public demo','user',true,false,
        false,0,0,0,'admin',20,100,0.1,0.1);
    INSERT INTO public.account(id,account_id,provider_id,user_id,password)
      VALUES(gen_random_uuid()::text,p_id::text,'credential',p_id::text,p_hash);
  END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA videoq_security FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA videoq_security FROM PUBLIC;
GRANT SELECT ON videoq_security.smoke_users,videoq_security.smoke_videos,videoq_security.smoke_visual_runs,
  videoq_security.smoke_external_tasks,videoq_security.smoke_courses,videoq_security.smoke_scene_embeddings,
  videoq_security.smoke_chat_logs TO videoq_smoke_access;
GRANT EXECUTE ON FUNCTION videoq_security.smoke_create(uuid,text,boolean),videoq_security.smoke_password(text,text),
  videoq_security.smoke_expire(text),videoq_security.smoke_delete(text) TO videoq_smoke_access;
GRANT SELECT ON videoq_security.demo_users,videoq_security.demo_courses,videoq_security.demo_videos,
  videoq_security.demo_scene_embeddings TO videoq_audit_access,videoq_demo_access;
GRANT EXECUTE ON FUNCTION videoq_security.demo_prepare(uuid,text) TO videoq_demo_access;
GRANT SELECT ON ALL TABLES IN SCHEMA videoq_security TO videoq_backup_access;
ALTER DEFAULT PRIVILEGES IN SCHEMA videoq_security GRANT SELECT ON TABLES TO videoq_backup_access;
RESET ROLE;
