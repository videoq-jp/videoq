-- drizzle-kit:custom
-- Custom data migration: preserve replay protection for receipts predating reservations.
-- The namespace must match operationReservationKey; no actor/course/action/time is copied.
INSERT INTO lti_operation_reservations(key)
SELECT key FROM (
  SELECT encode(sha256(convert_to('videoq:lti-operation:v1:material:'||id::text,'UTF8')),'hex') key
    FROM lti_material_operations
  UNION ALL
  SELECT encode(sha256(convert_to('videoq:lti-operation:v1:tag:'||id::text,'UTF8')),'hex') key
    FROM lti_course_tag_operations
) reservations ORDER BY key ON CONFLICT DO NOTHING;
