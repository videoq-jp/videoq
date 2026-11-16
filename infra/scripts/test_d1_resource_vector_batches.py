import tempfile
import unittest
from d1_resource_transfer_journal import TransferJournal
from d1_resource_vector_batches import VectorBatch


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.journal = TransferJournal(self.directory.name,'a'*32,'b'*40,'c'*64,phases=('intent','accepted','verified'))
        self.vector = {'id':'v1','values':[0.5]*768,'metadata':{'user_id':'owner'}}
        self.stored,self.writes,self.lost = [],0,False
        def call(method,path,payload):
            if path.endswith('/get_by_ids'):
                return [row for row in self.stored if row['id'] in payload['ids']]
            self.writes += 1
            if self.lost:
                raise OSError('response lost')
            return {'mutationId':'accepted-1'}
        self.call = call
        self.batch = VectorBatch(self.journal,call,768,'upsert',[self.vector],lambda:None)

    def test_accepted_mutation_stays_pending_until_exact_values_arrive_without_repost(self):
        self.assertFalse(self.batch.run_next()['verified'])
        self.assertEqual(self.journal.read()[-1]['phase'],'accepted')
        self.assertFalse(self.batch.run_next()['verified'])
        self.assertEqual(self.writes,1)
        self.stored=[self.vector]
        self.assertTrue(self.batch.run_next()['verified'])
        self.assertTrue(self.batch.run_next()['verified'])
        self.assertEqual(self.writes,1)

    def test_lost_response_reconciles_by_values_and_never_reissues_unmatched_intent(self):
        self.lost=True
        with self.assertRaises(OSError):
            self.batch.run_next()
        self.assertTrue(self.batch.run_next()['reconciliationRequired'])
        self.assertEqual(self.writes,1)
        self.stored=[self.vector]
        self.assertTrue(self.batch.run_next()['verified'])
        self.assertEqual(self.writes,1)
        self.assertTrue(self.journal.read()[1]['value']['reconciledByReadback'])

    def test_verified_values_cannot_drift_or_payload_change_silently(self):
        self.stored=[self.vector]
        self.assertTrue(self.batch.run_next()['verified'])
        self.assertEqual(self.writes,0)
        self.stored=[]
        with self.assertRaisesRegex(ValueError,'VERIFICATION_CHANGED'):
            self.batch.run_next()
        other = VectorBatch(self.journal,self.call,768,'upsert',[{**self.vector,'id':'other'}],lambda:None)
        with self.assertRaisesRegex(ValueError,'PAYLOAD_CHANGED'):
            other.run_next()

    def test_delete_verifies_absence_instead_of_acceptance_and_rechecks_safety(self):
        self.stored=[self.vector]
        batch = VectorBatch(self.journal,self.call,768,'delete_by_ids',{'ids':['v1']},lambda:None)
        self.assertFalse(batch.run_next()['verified'])
        self.stored=[]
        self.assertTrue(batch.run_next()['verified'])
        def unsafe():
            raise ValueError('RESOURCE_FENCE_LOST')
        batch.safe=unsafe
        with self.assertRaisesRegex(ValueError,'FENCE_LOST'):
            batch.run_next()


if __name__ == '__main__':
    unittest.main()
