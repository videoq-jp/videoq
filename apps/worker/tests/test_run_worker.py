from unittest.mock import MagicMock
import signal

import pytest

from scripts import run_worker


@pytest.mark.parametrize("handler_crashes", [False, True])
def test_poller_reuses_one_client_and_closes_it_on_shutdown(
    monkeypatch, handler_crashes
):
    monkeypatch.setenv("SQS_QUEUE_URL", "https://example.invalid/test")
    client = MagicMock()
    client.receive_message.side_effect = [
        {
            "Messages": [
                {"MessageId": "failed", "Body": "first", "ReceiptHandle": "receipt-1"},
                {"MessageId": "ok", "Body": "second", "ReceiptHandle": "receipt-2"},
            ]
        },
        KeyboardInterrupt(),
    ]
    create = MagicMock(return_value=client)
    monkeypatch.setattr(run_worker, "create_sqs_client", create)
    handler = MagicMock(
        return_value={"batchItemFailures": [{"itemIdentifier": "failed"}]}
    )
    if handler_crashes:
        handler.side_effect = RuntimeError("Worker failed")
    monkeypatch.setattr(run_worker, "handler", handler)

    assert run_worker.main() == 0
    create.assert_called_once()
    assert client.receive_message.call_count == 2
    handler.assert_called_once_with(
        {
            "Records": [
                {"messageId": "failed", "body": "first"},
                {"messageId": "ok", "body": "second"},
            ]
        },
        None,
    )
    if handler_crashes:
        client.delete_message.assert_not_called()
    else:
        client.delete_message.assert_called_once_with(
            QueueUrl="https://example.invalid/test",
            ReceiptHandle="receipt-2",
        )
    client.close.assert_called_once()


def test_sigterm_drains_and_acknowledges_active_job(monkeypatch):
    monkeypatch.setenv("SQS_QUEUE_URL", "http://queue/test")
    client = MagicMock()
    client.receive_message.return_value = {"Messages": [
        {"MessageId": "one", "Body": "{}", "ReceiptHandle": "receipt"}
    ]}
    monkeypatch.setattr(run_worker, "create_sqs_client", lambda: client)

    def handler(_event, _context):
        signal.raise_signal(signal.SIGTERM)
        return {}

    monkeypatch.setattr(run_worker, "handler", handler)
    assert run_worker.main() == 0
    client.receive_message.assert_called_once()
    client.delete_message.assert_called_once_with(QueueUrl="http://queue/test", ReceiptHandle="receipt")
    client.close.assert_called_once()


def test_deadline_does_not_acknowledge_unfinished_work(monkeypatch):
    monkeypatch.setenv("SQS_QUEUE_URL", "http://queue/test")
    client = MagicMock()
    client.receive_message.side_effect = [{"Messages": [
        {"MessageId": "one", "Body": "{}", "ReceiptHandle": "receipt"}
    ]}, KeyboardInterrupt()]
    monkeypatch.setattr(run_worker, "create_sqs_client", lambda: client)
    monkeypatch.setattr(run_worker, "handler", MagicMock(side_effect=run_worker.JobDeadlineExceeded()))
    assert run_worker.main() == 0
    client.delete_message.assert_not_called()
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0


def test_poller_requests_and_forwards_receive_count(monkeypatch):
    monkeypatch.setenv('SQS_QUEUE_URL', 'http://queue/test')
    client = MagicMock()
    client.receive_message.side_effect = [{'Messages': [{
        'MessageId': 'one', 'Body': '{}', 'ReceiptHandle': 'receipt',
        'Attributes': {'ApproximateReceiveCount': '3'},
    }]}, KeyboardInterrupt()]
    monkeypatch.setattr(run_worker, 'create_sqs_client', lambda: client)
    handler = MagicMock(return_value={})
    monkeypatch.setattr(run_worker, 'handler', handler)
    assert run_worker.main() == 0
    assert client.receive_message.call_args.kwargs['MessageSystemAttributeNames'] == ['ApproximateReceiveCount']
    assert handler.call_args.args[0]['Records'][0]['attributes'] == {'ApproximateReceiveCount': '3'}


@pytest.mark.parametrize('batch_size', ['0', '2', '10', '11', '-1'])
def test_media_poller_rejects_batches_that_share_one_execution_deadline(monkeypatch, batch_size):
    monkeypatch.setenv('SQS_QUEUE_URL', 'http://queue/test')
    monkeypatch.setenv('SQS_MAX_MESSAGES', batch_size)
    create = MagicMock(side_effect=AssertionError('Validation must precede client creation'))
    monkeypatch.setattr(run_worker, 'create_sqs_client', create)
    with pytest.raises(ValueError, match='SQS_MAX_MESSAGES must be 1'):
        run_worker.main()
    create.assert_not_called()


def test_only_one_media_job_is_received_for_each_execution_budget(monkeypatch):
    monkeypatch.setenv('SQS_QUEUE_URL', 'http://queue/test')
    monkeypatch.setenv('SQS_MAX_MESSAGES', '1')
    client = MagicMock()
    client.receive_message.side_effect = [
        {'Messages': [{'MessageId': 'finished', 'Body': '{}', 'ReceiptHandle': 'first'}]},
        {'Messages': [{'MessageId': 'unfinished', 'Body': '{}', 'ReceiptHandle': 'second'}]},
        KeyboardInterrupt(),
    ]
    monkeypatch.setattr(run_worker, 'create_sqs_client', lambda: client)
    monkeypatch.setattr(run_worker, 'handler', MagicMock(side_effect=[{}, run_worker.JobDeadlineExceeded()]))
    assert run_worker.main() == 0
    client.delete_message.assert_called_once_with(QueueUrl='http://queue/test', ReceiptHandle='first')
    assert all(call.kwargs['MaxNumberOfMessages'] == 1 for call in client.receive_message.call_args_list)
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0
