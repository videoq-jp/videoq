const ORIGIN = 'https://videoq.jp';
const SLUG = 'videoq-campus-basics-v1';
const OWNER = { username: 'videoq_public_demo', email: 'public-demo@videoq.jp', name: 'VideoQ public demo', role: 'user', quota_source: 'admin' };
const ANSWERS = 100;
function verifyOwner(owner) {
  if (owner && (Object.entries(OWNER).some(([key,value]) => owner[key] !== value) || owner.is_over_quota !== false)) throw new Error('DEMO_OWNER_IDENTITY_MISMATCH');
}
function verifyCourse(course, owner, description) {
  if (course && (!owner || course.user_id !== owner.id || course.description !== description)) throw new Error('DEMO_SLUG_OWNED_BY_OTHER_CONTENT');
}
module.exports = { ORIGIN, SLUG, OWNER, ANSWERS, verifyOwner, verifyCourse };
