import unittest
from d1_resource_vector_plan import plan_vectors


def authority(identifier='v1', dimensions=768, **extra):
    return {'vector_id': identifier, 'scene_id': 'scene', 'revision': 'revision', 'video_id': 1,
            'user_id': 'owner', 'dimensions': dimensions, 'legacy': False, 'pending_payload': False, **extra}


def vector(identifier='v1', dimensions=768):
    return {'id': identifier, 'values': [0.5] * dimensions, 'metadata': {'vector_id': identifier,
            'scene_id': 'scene', 'revision': 'revision', 'video_id': 1, 'user_id': 'owner', 'text': ''}}


class VectorPlanTests(unittest.TestCase):
    def plan(self, rows=None, source=None, candidate=None):
        return plan_vectors(rows if rows is not None else [authority()],
                            {768: [vector()] if source is None else source, 1536: []},
                            {768: [] if candidate is None else candidate, 1536: []})

    def test_preserves_exact_values_and_metadata_but_removes_orphans_from_candidate(self):
        original = vector()
        proof = self.plan(source=[original, vector('obsolete-source')], candidate=[vector(), vector('obsolete-candidate')])
        index = proof['indexes'][0]
        self.assertEqual(index['upsert'], [original])
        self.assertEqual(index['delete'], ['obsolete-candidate'])
        self.assertFalse(proof['modelCallsRequired'])
        self.assertFalse(proof['outboxMutationsRequired'])

    def test_current_vectors_cannot_change_owner_video_scene_or_revision(self):
        for field, value in [('user_id', 'other'), ('video_id', 2), ('scene_id', 'other'), ('revision', 'other'), ('vector_id', 'other')]:
            row = vector()
            row['metadata'][field] = value
            with self.assertRaisesRegex(ValueError, 'MISMATCH'):
                self.plan(source=[row])

    def test_missing_current_vector_refuses_without_retained_pending_payload(self):
        with self.assertRaisesRegex(ValueError, 'SOURCE_MISSING'):
            self.plan(source=[])
        proof = self.plan(rows=[authority(pending_payload=True)], source=[], candidate=[vector()])
        self.assertEqual(proof['indexes'][0]['deferred'], ['v1'])
        self.assertEqual(proof['indexes'][0]['delete'], ['v1'])
        self.assertFalse(proof['outboxMutationsRequired'])

    def test_duplicate_ids_conflicting_authority_and_invalid_values_refuse_plan(self):
        with self.assertRaisesRegex(ValueError, 'ID_INVALID'):
            self.plan(source=[vector(), vector()])
        with self.assertRaisesRegex(ValueError, 'COLLISION'):
            self.plan(rows=[authority(), authority(user_id='other')])
        for values in [[float('nan')] * 768, [0] * 768, [1e100] * 768, [1]]:
            row = vector()
            row['values'] = values
            with self.assertRaisesRegex(ValueError, 'VALUES_INVALID'):
                self.plan(source=[row])

    def test_legacy_scene_id_vector_is_retained_without_synthesizing_metadata(self):
        row = vector('scene')
        del row['metadata']['vector_id']
        proof = self.plan(rows=[authority('scene', legacy=True)], source=[row])
        self.assertEqual(proof['indexes'][0]['upsert'], [row])

    def test_default_namespace_normalizes_and_other_namespaces_need_review(self):
        row = vector()
        row['namespace'] = None
        self.assertNotIn('namespace', self.plan(source=[row])['indexes'][0]['upsert'][0])
        row['namespace'] = 'other'
        with self.assertRaisesRegex(ValueError, 'NAMESPACE_REVIEW'):
            self.plan(source=[row])

class VectorReadbackTests(unittest.TestCase):
    def test_accepted_mutation_and_correct_ids_are_insufficient_until_values_and_metadata_match(self):
        from d1_resource_vector_plan import candidate_status
        expected = vector()
        plan = plan_vectors([authority()],{768:[expected],1536:[]},{768:[],1536:[]})
        self.assertFalse(candidate_status(plan,{768:[],1536:[]})['verified'])
        changed = vector()
        changed['values'][0] = 0.25
        self.assertFalse(candidate_status(plan,{768:[changed],1536:[]})['verified'])
        changed = vector()
        changed['metadata']['user_id'] = 'other'
        self.assertFalse(candidate_status(plan,{768:[changed],1536:[]})['verified'])
        self.assertTrue(candidate_status(plan,{768:[expected],1536:[]})['verified'])
        self.assertFalse(candidate_status(plan,{768:[expected,vector('orphan')],1536:[]})['verified'])

    def test_deferred_outbox_work_is_visible_in_verified_static_copy_receipt(self):
        from d1_resource_vector_plan import candidate_status
        plan = plan_vectors([authority(pending_payload=True)],{768:[],1536:[]},{768:[],1536:[]})
        receipt = candidate_status(plan,{768:[],1536:[]})
        self.assertTrue(receipt['verified'])
        self.assertEqual(receipt['indexes'][0]['deferredPending'],1)


if __name__ == '__main__':
    unittest.main()
