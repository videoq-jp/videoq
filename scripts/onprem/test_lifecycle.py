"""Opt-in real Docker lifecycle test; uses disposable uniquely named projects.

VIDEOQ_ONPREM_LIFECYCLE=1 VIDEOQ_DOCKER_SUDO=1 python3 -m unittest discover \
  -s scripts/onprem -p test_lifecycle.py -v

Requires locally built production images videoq-{api,worker,web}:onprem-ci.
No live AI provider is called. Real model quality remains separately validated.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("videoq", Path(__file__).with_name("videoq.py"))
videoq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(videoq)


@unittest.skipUnless(os.environ.get("VIDEOQ_ONPREM_LIFECYCLE") == "1", "opt-in Docker lifecycle")
class LifecycleTest(unittest.TestCase):
    def test_start_restart_backup_restore(self):
        with tempfile.TemporaryDirectory(prefix="videoq-single-server-") as temporary:
            root = Path(temporary)
            target, restored = root / "server", root / "restored"
            values = {c: {"image": {"repository": f"videoq-{c}", "digest": "sha256:" + "a" * 64}}
                      for c in ("api", "worker", "web")}
            images = root / "images.json"
            images.write_text(json.dumps(values))
            args = argparse.Namespace(directory=str(target), images=str(images),
                                      url="http://localhost:18090", storage_url="http://localhost:18091", offline=True)
            with patch.dict(os.environ, {"VIDEOQ_OPENROUTER_API_KEY": "lifecycle-no-live-provider"}):
                videoq.initialize(args)
            config_path = target / "compose.json"
            config = json.loads(config_path.read_text())
            ids = {}
            for component in ("api", "worker", "web"):
                ids[component] = subprocess.run([*videoq.docker_command(), "image", "inspect", f"videoq-{component}:onprem-ci",
                                                 "--format", "{{.Id}}"], check=True, capture_output=True, text=True).stdout.strip()
            for service, data in config["services"].items():
                for component in ids:
                    if data["image"].startswith(f"videoq-{component}@"):
                        data["image"] = ids[component]
            config["services"]["gateway"]["ports"] = ["127.0.0.1:18090:18090", "127.0.0.1:18091:18091"]
            config_path.write_text(json.dumps(config))
            try:
                videoq.start(args)
                videoq.doctor(argparse.Namespace(directory=str(target), live=True, ai=False))
                videoq.docker(target, "exec", "-T", "postgres", "psql", "-U", "videoq", "-d", "videoq", "-c",
                              "CREATE TABLE installer_probe(value text); INSERT INTO installer_probe VALUES ('retained');")
                probe = """
import boto3, os
from botocore.config import Config
config=Config(connect_timeout=3,read_timeout=8,retries={'max_attempts':2})
s3=boto3.client('s3',endpoint_url='http://garage:3900',region_name='garage',aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],config=config)
q=boto3.client('sqs',endpoint_url='http://queue:9324',region_name='us-east-1',aws_access_key_id='test',aws_secret_access_key='test',config=config)
"""
                write = probe + """
s3.put_object(Bucket='videoq-media',Key='installer-probe',Body=b'retained')
url=q.create_queue(QueueName='installer-probe')['QueueUrl']
q.send_message(QueueUrl=url,MessageBody='retained')
"""
                read = probe + """
assert s3.get_object(Bucket='videoq-media',Key='installer-probe')['Body'].read()==b'retained'
url=q.get_queue_url(QueueName='installer-probe')['QueueUrl']
messages=q.receive_message(QueueUrl=url,VisibilityTimeout=0,WaitTimeSeconds=5)['Messages']
assert messages[0]['Body']=='retained'
"""
                def worker_script(directory, code):
                    videoq.docker(directory, "run", "--rm", "--no-deps", "-T", "--entrypoint", "python", "worker", "-c", code)
                worker_script(target, write)
                videoq.docker(target, "restart", "queue", "garage")
                videoq.docker(target, "up", "-d", "--wait", "--wait-timeout", "90", "queue", "garage")
                worker_script(target, read)
                videoq.backup_directory(target, root / "backup")
                videoq.stop(args)
                videoq.restore(argparse.Namespace(directory=str(restored), backup=str(root / "backup")))
                restored_args = argparse.Namespace(directory=str(restored), offline=True)
                videoq.start(restored_args)
                videoq.doctor(argparse.Namespace(directory=str(restored), live=True, ai=False))
                result = videoq.docker(restored, "exec", "-T", "postgres", "psql", "-U", "videoq", "-d", "videoq", "-Atc",
                                       "SELECT value FROM installer_probe", capture_output=True, text=True)
                self.assertEqual(result.stdout.strip(), "retained")
                worker_script(restored, read)
                self.assertEqual((target / "runtime.env").read_bytes(), (restored / "runtime.env").read_bytes())
            finally:
                for directory in (restored, target):
                    if (directory / "compose.json").exists():
                        videoq.docker(directory, "down", "--timeout", "30", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    unittest.main()
