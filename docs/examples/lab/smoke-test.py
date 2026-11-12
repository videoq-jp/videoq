#!/usr/bin/env python3
"""Private lab acceptance: real upload/ASR/index/Q&A/SSE/range, no browser QA."""

import argparse
import http.cookiejar
import json
from pathlib import Path
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path("/etc/videoq-updater")
ORIGIN = ""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class LocalRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(
            urllib.parse.urlsplit(newurl)[:2] == urllib.parse.urlsplit(ORIGIN)[:2],
            "Unexpected redirect origin",
        )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    global ORIGIN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=ROOT / "smoke-policy.json")
    args = parser.parse_args()
    policy = json.loads(args.policy.read_text())
    ORIGIN = policy["public_url"]
    url = urllib.parse.urlsplit(ORIGIN)
    require(
        url.scheme == "https"
        and bool(url.hostname)
        and not url.username
        and not url.password
        and url.path == ""
        and not url.query
        and not url.fragment,
        "Invalid HTTPS public_url",
    )
    transcript_patterns = policy["transcript_patterns"]
    answer_patterns = policy["answer_patterns"]
    require(
        bool(transcript_patterns) and bool(answer_patterns),
        "Expected-content patterns required",
    )
    for pattern in transcript_patterns + answer_patterns:
        re.compile(pattern, re.IGNORECASE)
    jar = http.cookiejar.CookieJar()
    context = ssl.create_default_context(cafile="/etc/videoq-bootstrap/lab-ca.crt")
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        LocalRedirect(),
        urllib.request.HTTPSHandler(context=context),
        urllib.request.HTTPCookieProcessor(jar),
    )

    def request(path, data=None, method=None, headers=None, timeout=120):
        url = urllib.parse.urljoin(ORIGIN + "/", path)
        require(
            urllib.parse.urlsplit(url)[:2] == urllib.parse.urlsplit(ORIGIN)[:2],
            "Unexpected request origin",
        )
        merged = {"Origin": ORIGIN}
        merged.update(headers or {})
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            merged["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=merged, method=method)
        try:
            return opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            raise RuntimeError("HTTP failure: " + str(exc.code)) from None
        except urllib.error.URLError:
            raise RuntimeError("HTTPS connection failed") from None

    def rpc(name, payload, query=False):
        path = "/api/trpc/" + name
        if query:
            path += "?input=" + urllib.parse.quote(json.dumps(payload))
        with request(
            path, None if query else payload, "GET" if query else "POST"
        ) as response:
            result = json.load(response)
        require(
            "result" in result and "data" in result["result"],
            "Invalid RPC response: " + name,
        )
        return result["result"]["data"]

    with request("/ready") as response:
        require(
            json.load(response).get("data", {}).get("db") == "ok", "DB is not ready"
        )
    credentials = json.loads((ROOT / "smoke-credentials.json").read_text())
    with request("/api/auth/sign-in/email", credentials) as response:
        require(response.status == 200 and bool(list(jar)), "Login failed")
    del credentials
    if policy.get("baseline_course_id"):
        baseline = rpc("courses.get", {"id": policy["baseline_course_id"]}, True)
        require(
            baseline.get("id") == policy["baseline_course_id"],
            "Baseline course is inaccessible",
        )
    print("PASS: verified HTTPS, DB and dedicated login", flush=True)

    fixture = (ROOT / "fixture.mp4").read_bytes()
    require(0 < len(fixture) < 20 * 1024 * 1024, "Fixture size outside test limit")
    name = "Automatic update check " + str(uuid.uuid4())
    created = rpc(
        "videos.requestUpload",
        {
            "filename": "update-check.mp4",
            "contentType": "video/mp4",
            "fileSize": len(fixture),
            "title": name,
            "transcriptionLanguage": policy.get("language", "ja"),
        },
    )
    video_id = created["video"]["id"]
    print("Created test video id=" + str(video_id), flush=True)
    with request(
        created["upload_url"], fixture, "PUT", {"Content-Type": "video/mp4"}
    ) as response:
        require(response.status in (200, 201, 204), "Upload failed")
    rpc("videos.confirmUpload", {"id": video_id})
    deadline = time.monotonic() + 360
    while True:
        video = rpc("videos.get", {"id": video_id}, True)
        require(video["status"] not in ("error", "failed"), "Video processing failed")
        if video["status"] == "completed":
            break
        require(time.monotonic() < deadline, "Video processing timeout")
        time.sleep(5)
    transcript = video.get("transcript") or ""
    require(
        all(
            re.search(pattern, transcript, re.IGNORECASE)
            for pattern in transcript_patterns
        ),
        "Unexpected transcription content",
    )
    print("PASS: fresh upload, real transcription and indexing", flush=True)
    course = rpc("courses.create", {"name": name})
    course_id = course["id"]
    print("Created test course id=" + str(course_id), flush=True)
    rpc("memberships.addVideo", {"courseId": course_id, "videoId": video_id})
    messages = [{"role": "user", "content": policy["question"]}]
    answer = rpc("chat.send", {"courseId": course_id, "messages": messages})["answer"]
    text = "".join(segment["text"] for segment in answer["segments"])
    require(
        all(re.search(pattern, text, re.IGNORECASE) for pattern in answer_patterns),
        "Unexpected answer topic or detail",
    )
    sources = [source for source in answer["sources"] if source["video_id"] == video_id]
    require(bool(sources), "Answer did not cite the new test video")
    source_ids = {source["id"] for source in sources}
    require(
        any(
            source_ids.intersection(segment["sourceIds"])
            for segment in answer["segments"]
        ),
        "No inline citation to the new test video",
    )
    require(
        any(
            re.fullmatch(r"\d+:\d{2}:\d{2},\d{3}", source.get("start_time") or "")
            for source in sources
        ),
        "No timestamped citation",
    )
    print("PASS: cited answer with expected topic and timestamp", flush=True)
    with request(
        "/api/chat/messages/stream", {"course_id": course_id, "messages": messages}
    ) as response:
        events = [
            json.loads(line[6:])
            for line in response.read().decode().splitlines()
            if line.startswith("data: ")
        ]
    require(
        not any(event.get("type") == "error" for event in events),
        "SSE reported an error",
    )
    require(any(event.get("type") == "done" for event in events), "SSE did not finish")
    require(
        any(event.get("type") == "citation" for event in events), "SSE citation missing"
    )
    with request(video["file"], headers={"Range": "bytes=0-15"}) as response:
        require(
            response.status == 206 and len(response.read(17)) == 16,
            "Media byte-range failed",
        )
    print(
        "PASS: streaming answer and media HTTP 206 (browser playback checked manually)",
        flush=True,
    )
    # Only delete resources created by this invocation, and only after success.
    rpc("courses.delete", {"id": course_id})
    rpc("videos.delete", {"id": video_id})
    print("PASS: test resources cleaned; existing resources retained", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Never emit response bodies, credentials, signed URLs or session cookies.
        print(
            "FAIL: " + (str(exc) if type(exc) is RuntimeError else type(exc).__name__),
            file=sys.stderr,
        )
        sys.exit(1)
