"""Run authenticated infrastructure checks from the production worker network."""
import argparse
from contextlib import closing
import json
import os
import sys
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

import boto3
from botocore.config import Config


def verify_queues(client, environment):
    urls = [environment.get("SQS_MEDIA_QUEUE_URL") or environment["SQS_QUEUE_URL"],
            environment["SQS_SEARCH_QUEUE_URL"], environment["SQS_ACCOUNT_QUEUE_URL"]]
    if not all(urls) or len(set(urls)) != 3:
        raise ValueError("Media, search and account queues must be distinct")
    dead_letters = []
    for url in urls:
        attributes = client.get_queue_attributes(QueueUrl=url, AttributeNames=["All"])["Attributes"]
        if int(attributes["VisibilityTimeout"]) < 900:
            raise ValueError("Queue visibility is shorter than the execution lease")
        policy = json.loads(attributes["RedrivePolicy"])
        if not policy["deadLetterTargetArn"] or int(policy["maxReceiveCount"]) < 1:
            raise ValueError("Missing queue dead-letter policy")
        dead_letters.append(policy["deadLetterTargetArn"])
    if len(set(dead_letters)) != 3:
        raise ValueError("Each workload group requires its own dead-letter queue")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ai", action="store_true")
    args = parser.parse_args()
    config = Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 1})
    failed = False

    def check(label, operation):
        nonlocal failed
        try:
            operation()
            print(f"OK: {label}")
        except Exception as error:
            # Provider exceptions can contain URLs/credentials. Print only error type.
            print(f"FAIL: {label} ({type(error).__name__})", file=sys.stderr)
            failed = True

    def storage():
        with closing(boto3.client("s3", endpoint_url=os.environ["R2_S3_INTERNAL_ENDPOINT"],
                          aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                          aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                          region_name=os.environ["R2_S3_REGION"], config=config)) as client:
            bucket = os.environ["R2_BUCKET_NAME"]
            client.head_bucket(Bucket=bucket)
            rules = client.get_bucket_cors(Bucket=bucket)["CORSRules"]
            assert any(os.environ["BETTER_AUTH_URL"] in rule["AllowedOrigins"]
                       and {"GET", "HEAD", "PUT"}.issubset(rule["AllowedMethods"])
                       and "ETag" in rule.get("ExposeHeaders", []) for rule in rules), "CORS"

    def queue():
        with closing(boto3.client("sqs", endpoint_url="http://queue:9324", region_name=os.environ["AWS_REGION"],
                          aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
                          aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"], config=config)) as client:
            verify_queues(client, os.environ)

    check("S3認証・バケット・ブラウザー用CORS", storage)
    check("メディア・検索・アカウントのキュー接続・実行リース・デッドレター設定", queue)
    check("API /ready", lambda: urlopen("http://api:8787/ready", timeout=10).close())
    if args.ai:
        for label, endpoint, key, model in (
            ("チャット", os.environ.get("LLM_BASE_URL") or os.environ["OPENAI_BASE_URL"],
             os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENROUTER_API_KEY"), os.environ["LLM_MODEL"]),
            ("埋め込み", os.environ.get("EMBEDDING_BASE_URL") or os.environ["OPENAI_BASE_URL"],
             os.environ.get("EMBEDDING_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENROUTER_API_KEY"), os.environ["EMBEDDING_MODEL"]),
        ):
            def models(endpoint=endpoint, key=key, model=model, label=label):
                # OpenRouter lists embeddings separately; local OpenAI-compatible
                # servers expose the usual /models endpoint.
                suffix = "/embeddings/models" if label == "埋め込み" and urlsplit(endpoint).hostname == "openrouter.ai" else "/models"
                request = Request(endpoint.rstrip("/") + suffix, headers={"Authorization": f"Bearer {key}"})
                with urlopen(request, timeout=20) as response:
                    available = json.load(response)
                assert model in {item["id"] for item in available["data"]}, "model not advertised"
            check(f"{label}API・指定モデル（推論は実行しません）", models)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
