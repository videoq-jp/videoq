"""Read-only DB/queue observations, executed inside the installed worker Pod."""
import json
import os
import sys

SQL = """SELECT json_build_object(
 'videos', (SELECT count(*) FROM videos WHERE status IN ('pending', 'processing')),
 'uploads', (SELECT count(*) FROM videos WHERE multipart_upload IS NOT NULL),
 'jobs', (SELECT count(*) FROM job_executions WHERE status='running'),
 'visual_runs', (SELECT count(*) FROM video_visual_runs WHERE status='processing'),
 'answers', (SELECT count(*) FROM ai_answer_attempts WHERE status='started' AND finished_at IS NULL)
)"""
QUEUE_ATTRIBUTES = {
    'queue_visible': 'ApproximateNumberOfMessages',
    'queue_inflight': 'ApproximateNumberOfMessagesNotVisible',
    'queue_delayed': 'ApproximateNumberOfMessagesDelayed',
}


def observe(connection, queue, queue_url):
    result = connection.execute(SQL).fetchone()[0]
    if not isinstance(result, dict) or set(result) != {'videos', 'uploads', 'jobs', 'visual_runs', 'answers'}:
        raise ValueError('Incomplete database workload observation')
    attributes = queue.get_queue_attributes(QueueUrl=queue_url,
        AttributeNames=list(QUEUE_ATTRIBUTES.values()))['Attributes']
    for name, attribute in QUEUE_ATTRIBUTES.items():
        value = attributes[attribute]
        if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
            raise ValueError('Invalid queue workload observation')
        result[name] = int(value)
    if any(type(value) is not int or value < 0 for value in result.values()):
        raise ValueError('Invalid database workload observation')
    return result


def main():
    import boto3
    from botocore.config import Config
    import psycopg
    from contextlib import closing
    try:
        with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=5) as connection:
            connection.execute('SET TRANSACTION READ ONLY')
            with closing(boto3.client('sqs', endpoint_url='http://queue:9324',
                    region_name=os.environ['AWS_REGION'], aws_access_key_id=os.environ['AWS_ACCESS_KEY_ID'],
                    aws_secret_access_key=os.environ['AWS_SECRET_ACCESS_KEY'],
                    config=Config(connect_timeout=5, read_timeout=10, retries={'max_attempts': 1}))) as queue:
                result = observe(connection, queue, os.environ['SQS_QUEUE_URL'])
        print(json.dumps(result))
        return 0
    except Exception as error:
        # Provider exceptions may contain connection URLs or credentials.
        print('Workload observation failed: ' + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
