"""Opt-in private SQS test bridge; never creates queues or reads other queues."""
import json
import re
import sys
from urllib.parse import urlparse

import boto3
from botocore.config import Config


def main():
    request = json.load(sys.stdin)
    config = request["config"]
    region, account, name, nonce = (config[k] for k in ("region", "account", "queueName", "nonce"))
    if region != "ap-northeast-1" or not re.fullmatch(r"\d{12}", account):
        raise ValueError("Invalid isolated SQS region/account")
    if not re.fullmatch(r"videoq-recovery-\d{8}-[a-f0-9]{8}", name) or not re.fullmatch(r"[a-f0-9]{32}", nonce):
        raise ValueError("Invalid isolated queue identity")
    url = urlparse(config["queueUrl"])
    if url.scheme != "https" or url.netloc != f"sqs.{region}.amazonaws.com" or url.path != f"/{account}/{name}" or url.query or url.fragment:
        raise ValueError("Invalid isolated queue URL")
    sdk = Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 0})
    sqs = boto3.client("sqs", region_name=region, config=sdk)
    tags = sqs.list_queue_tags(QueueUrl=config["queueUrl"]).get("Tags", {})
    if tags.get("videoq-operation") != "isolated-sqs-recovery" or tags.get("videoq-nonce") != nonce:
        raise ValueError("Queue ownership tags mismatch")
    args = {"QueueUrl": config["queueUrl"]}
    action = request["action"]
    if action == "validate":
        if boto3.client("sts", config=sdk).get_caller_identity()["Account"] != account:
            raise ValueError("AWS account mismatch")
        result = {"ownedQueue": True}
    elif action == "send":
        message = request["message"]
        if message.get("jobType") != "transcribe" or not re.fullmatch(r"[a-f0-9]{64}", message.get("payloadSha256", "")) or not message.get("jobId", "").startswith("sqs-recovery-" + nonce + "-"):
            raise ValueError("Only synthetic recovery jobs may be sent")
        result = {"id": sqs.send_message(**args, MessageBody=json.dumps(message))["MessageId"]}
    elif action == "receive":
        messages = sqs.receive_message(**args, MaxNumberOfMessages=10, WaitTimeSeconds=1, VisibilityTimeout=10, MessageSystemAttributeNames=["ApproximateReceiveCount"]).get("Messages", [])
        result = [{"id": m["MessageId"], "body": json.loads(m["Body"]), "receipt": m["ReceiptHandle"], "receiveCount": int(m["Attributes"]["ApproximateReceiveCount"])} for m in messages]
    elif action == "release":
        sqs.change_message_visibility(**args, ReceiptHandle=request["receipt"], VisibilityTimeout=0)
        result = {"released": True}
    elif action == "delete":
        sqs.delete_message(**args, ReceiptHandle=request["receipt"])
        result = {"deleted": True}
    else:
        raise ValueError("Unsupported SQS test action")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never echo credentials, message receipts or SDK exception responses.
        print("Isolated SQS bridge failed", file=sys.stderr)
        sys.exit(1)
