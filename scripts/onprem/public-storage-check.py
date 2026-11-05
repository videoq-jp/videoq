"""Prepare/clean up signed S3 probes; public HTTPS requests run on the VPS."""
import argparse
import base64
import json
import os
import re
import secrets
import sys
from contextlib import closing

import boto3
from botocore.config import Config


def main():
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--prepare', action='store_true')
    action.add_argument('--cleanup')
    args = parser.parse_args()
    settings = dict(region_name=os.environ['R2_S3_REGION'],
                    aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
                    aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
                    config=Config(signature_version='s3v4', connect_timeout=5, read_timeout=10,
                                  retries={'max_attempts': 1}, s3={'addressing_style': 'path'}))
    bucket = os.environ['R2_BUCKET_NAME']
    endpoint = os.environ['R2_S3_INTERNAL_ENDPOINT'] if args.cleanup else os.environ['BETTER_AUTH_URL']
    with closing(boto3.client('s3', endpoint_url=endpoint, **settings)) as client:
        if args.cleanup:
            if not re.fullmatch(r'media/_installer/[a-f0-9]{32}', args.cleanup):
                raise ValueError('Invalid probe key')
            client.delete_object(Bucket=bucket, Key=args.cleanup)
            return
        key = 'media/_installer/' + secrets.token_hex(16)
        upload = client.generate_presigned_url('put_object', Params={'Bucket': bucket, 'Key': key,
                                              'ContentType': 'application/octet-stream'}, ExpiresIn=120)
        download = client.generate_presigned_url('get_object', Params={'Bucket': bucket, 'Key': key}, ExpiresIn=120)
        # The host captures this output privately; no network request is made to the public origin here.
        print(json.dumps({'put': upload, 'get': download, 'payload': base64.b64encode(b'VideoQ storage probe\n').decode(), 'key': key}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never expose signed URLs or provider exception values in shared logs.
        print(f'Storage probe failed ({type(error).__name__}).', file=sys.stderr)
        raise SystemExit(1)
