#!/usr/bin/env python3
"""Wait for one trusted Jenkins SnappyMail paired-release receipt."""
from __future__ import annotations

import http.cookiejar
import base64
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import (HTTPRedirectHandler, HTTPCookieProcessor, Request,
                            build_opener)

BASE = "http://127.0.0.1:16155"
JOB_PATH = "/job/deploy-snappymail-boompay-ca"
QUEUE_RE = re.compile(r"^/queue/item/([1-9][0-9]*)/$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
IMAGE_RE = re.compile(r"^ghcr\.io/leopere/boompay-snappymail@sha256:[0-9a-f]{64}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def fail(message: str) -> None:
    raise SystemExit("deploy-production: " + message)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def base_url() -> str:
    # Production is deliberately fixed. The opt-in loopback override exists
    # solely for the offline protocol test.
    if os.environ.get("SNAPPYMAIL_JENKINS_TESTING") != "1":
        return BASE
    value = os.environ.get("SNAPPYMAIL_JENKINS_TEST_URL", "")
    parsed = urlparse(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or not parsed.port or parsed.path or parsed.query or parsed.fragment):
        fail("SNAPPYMAIL_JENKINS_TEST_URL must be one loopback HTTP origin")
    return value.rstrip("/")


def release_deadline() -> float:
    try:
        seconds = int(os.environ.get("SNAPPYMAIL_JENKINS_TIMEOUT_SECONDS", "1700"))
    except ValueError:
        fail("SNAPPYMAIL_JENKINS_TIMEOUT_SECONDS must be an integer")
    if not 1 <= seconds <= 1700:
        fail("SNAPPYMAIL_JENKINS_TIMEOUT_SECONDS must be between 1 and 1700")
    return time.monotonic() + seconds


def password_file() -> Path:
    if os.environ.get("SNAPPYMAIL_JENKINS_TESTING") == "1":
        value = os.environ.get("SNAPPYMAIL_JENKINS_TEST_PASSWORD_FILE", "")
        value or fail("SNAPPYMAIL_JENKINS_TEST_PASSWORD_FILE is required for offline testing")
        return Path(value)
    operator_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    return operator_home / ".local/share/jenkins-local/secrets/jenkins_admin_password"


def read_password() -> str:
    path = password_file()
    try:
        details = path.lstat()
    except OSError as error:
        fail("Jenkins admin password file is unavailable: " + str(error))
    if (not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode)
            or details.st_uid != os.getuid() or details.st_mode & 0o077):
        fail("Jenkins admin password file must be a private regular file")
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        fail("Jenkins admin password file is unreadable: " + str(error))
    if not value or "\n" in value or "\r" in value:
        fail("Jenkins admin password file is invalid")
    return value


def opener(base: str):
    # Jenkins returns 403 instead of a Basic challenge for crumbIssuer, so the
    # fixed local client must authenticate its first request preemptively.
    credential = base64.b64encode(("admin:" + read_password()).encode("utf-8")).decode("ascii")
    client = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect())
    client.addheaders = [("Authorization", "Basic " + credential)]
    return client


def deadline_remaining(limit: float | None) -> float:
    if limit is None:
        return 60
    remaining = limit - time.monotonic()
    if remaining <= 0:
        fail("Jenkins monitoring deadline elapsed; the existing build may still be active; resume monitoring by build number")
    return min(60, remaining)


def request(client, url: str, *, method: str = "GET", data: bytes | None = None,
            headers: dict[str, str] | None = None, limit: float | None = None):
    attempts = 3 if method == "GET" else 1
    for attempt in range(attempts):
        try:
            return client.open(Request(url, data=data, method=method, headers=headers or {}),
                               timeout=deadline_remaining(limit))
        except HTTPError as error:
            if method != "GET" or error.code not in {502, 503, 504} or attempt + 1 == attempts:
                return error
        except (TimeoutError, URLError) as error:
            if method != "GET" or attempt + 1 == attempts:
                reason = error.reason if isinstance(error, URLError) else error
                fail("Jenkins request failed: " + str(reason))
        delay = 0.1 if os.environ.get("SNAPPYMAIL_JENKINS_TESTING") == "1" else 2
        time.sleep(min(delay, deadline_remaining(limit)))


def object_json(client, url: str, limit: float | None = None) -> dict:
    response = request(client, url, limit=limit)
    if response.getcode() != 200:
        fail("Jenkins returned HTTP %s for %s" % (response.getcode(), urlparse(url).path))
    try:
        value = json.loads(response.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Jenkins returned invalid JSON for " + urlparse(url).path)
    if not isinstance(value, dict):
        fail("Jenkins returned a non-object JSON response")
    return value


def same_origin(value: str, base: str) -> bool:
    received, expected = urlparse(value), urlparse(base)
    return (received.scheme, received.hostname, received.port) == (expected.scheme, expected.hostname, expected.port)


def has_expected_revision(record: object, revision: str) -> bool:
    if not isinstance(record, dict) or not isinstance(record.get("actions"), list):
        return False
    values = []
    for action in record["actions"]:
        if not isinstance(action, dict) or not isinstance(action.get("parameters"), list):
            continue
        for parameter in action["parameters"]:
            if isinstance(parameter, dict) and parameter.get("name") == "EXPECTED_REVISION":
                values.append(parameter.get("value"))
    return values == [revision]


def metadata_url_matches(value: object, expected: str) -> bool:
    # Jenkins advertises its public root URL even when queried over loopback.
    # Validate metadata only; all authenticated requests still use the local API.
    return value in (expected, "https://jenkins.a250.ca" + urlparse(expected).path)


def valid_build(record: object, job: str, build: int) -> bool:
    return (isinstance(record, dict) and record.get("number") == build
            and metadata_url_matches(record.get("url"), job + "/%s/" % build))


def valid_queue_url(value: object, base: str, queue_path: str) -> bool:
    return isinstance(value, str) and (metadata_url_matches(value, base + queue_path)
                                      or value in {queue_path, queue_path.lstrip("/")})


def queued_item_build(client, base: str, job: str, queue_path: str, revision: str, limit: float) -> int | None:
    item = object_json(client, base + queue_path + "api/json", limit)
    if item.get("cancelled"):
        fail("Jenkins cancelled the SnappyMail queue item")
    task = item.get("task")
    if not isinstance(task, dict) or not metadata_url_matches(task.get("url"), job + "/"):
        fail("Jenkins queue item does not belong to the fixed SnappyMail job")
    if not has_expected_revision(item, revision):
        return None
    executable = item.get("executable")
    if executable is None:
        return 0
    if not isinstance(executable, dict) or not isinstance(executable.get("number"), int) or executable["number"] < 1:
        fail("Jenkins queue item has an invalid executable build")
    build = executable["number"]
    if not metadata_url_matches(executable.get("url"), job + "/%s/" % build):
        fail("Jenkins queue item does not resolve to the fixed SnappyMail job")
    return build


def find_existing(client, base: str, job: str, revision: str, limit: float) -> tuple[str, int | str] | None:
    state = object_json(client, job + "/api/json?tree=lastBuild[number,building,url,actions[parameters[name,value]]],queueItem[id,url]", limit)
    queued = state.get("queueItem")
    if queued is not None:
        if not isinstance(queued, dict) or not isinstance(queued.get("id"), int) or queued["id"] < 1:
            fail("Jenkins job returned an invalid queue item")
        queue_path = "/queue/item/%s/" % queued["id"]
        if not valid_queue_url(queued.get("url"), base, queue_path):
            fail("Jenkins job returned a queue item outside the fixed local origin")
        build = queued_item_build(client, base, job, queue_path, revision, limit)
        if isinstance(build, int) and build > 0:
            return ("build", build)
        if build == 0:
            return ("queue", queue_path)
    last = state.get("lastBuild")
    if not isinstance(last, dict) or last.get("building") is not True:
        return None
    build = last.get("number")
    if not isinstance(build, int) or build < 1 or not metadata_url_matches(last.get("url"), job + "/%s/" % build):
        fail("Jenkins job returned an invalid active build")
    current = object_json(client, job + "/%s/api/json?tree=number,building,url,actions[parameters[name,value]]" % build, limit)
    if not valid_build(current, job, build) or current.get("building") is not True:
        return None
    return ("build", build) if has_expected_revision(current, revision) else None


def wait_for(limit: float, label: str, check):
    while time.monotonic() < limit:
        value = check()
        if value is not None:
            return value
        time.sleep(0.1 if os.environ.get("SNAPPYMAIL_JENKINS_TESTING") == "1" else 2)
    fail("timed out waiting for Jenkins " + label + "; the existing build may still be active; resume monitoring by build number")


def validate_receipt(receipt: object, revision: str) -> None:
    if not isinstance(receipt, dict):
        fail("accepted release artifact is not an object")
    image, image_id = receipt.get("image"), receipt.get("image_id")
    if (receipt.get("schema") != "jenkins-boompay-image/v1" or receipt.get("application") != "snappymail"
            or receipt.get("revision") != revision):
        fail("accepted release artifact does not bind SnappyMail to the requested revision")
    if not isinstance(image, str) or not IMAGE_RE.fullmatch(image) or not isinstance(image_id, str) or not DIGEST_RE.fullmatch(image_id):
        fail("accepted release artifact has an invalid immutable image")
    if receipt.get("result") != "pass" or not isinstance(receipt.get("host_activation"), dict):
        fail("accepted release artifact does not record a successful host activation")
    host = receipt["host_activation"]
    if (host.get("schema") != "jenkins-host-appliance-activation/v1" or host.get("application") != "snappymail"
            or host.get("source_revision") != revision or host.get("image") != image
            or host.get("image_config_digest") != image_id or host.get("provenance") != "jenkins"):
        fail("host activation does not bind the requested SnappyMail image")
    pair = host.get("snappymail_pair")
    if not isinstance(pair, dict) or pair.get("schema") != "jenkins-snappymail-pair/v1":
        fail("accepted release artifact has no paired SnappyMail receipt")
    if pair.get("revision") != revision or pair.get("image") != image or pair.get("image_id") != image_id:
        fail("paired SnappyMail receipt does not bind the requested image and revision")
    if pair.get("targets") != ["mail.boompay.ca", "mail.nixc.us"]:
        fail("paired SnappyMail receipt does not prove both mail targets")
    runtime_ids = {target: pair.get(target + "_runtime_image_id") for target in ("boompay", "nix")}
    controllers = pair.get("controller_revisions", {})
    report = pair.get("openpgp_report", {})
    if any(not isinstance(runtime, str) or not DIGEST_RE.fullmatch(runtime)
           for runtime in runtime_ids.values()):
        fail("paired receipt lacks both verified runtime image IDs")
    if not isinstance(controllers, dict) or any(
            not isinstance(controllers.get(target), str) or not REVISION_RE.fullmatch(controllers[target])
            for target in ("boompay", "nix")):
        fail("paired receipt lacks both controller revisions")
    if (not isinstance(report, dict) or report.get("status") != "passed"
            or not isinstance(report.get("sha256"), str)
            or not re.fullmatch("[0-9a-f]{64}", report["sha256"])):
        fail("paired receipt lacks successful OpenPGP acceptance")


def monitor(client, job: str, revision: str, build: int, limit: float) -> None:
    def complete():
        status = object_json(client, job + "/%s/api/json" % build, limit)
        if not valid_build(status, job, build):
            fail("Jenkins build status does not belong to the fixed SnappyMail job")
        if status.get("building") is True:
            return None
        if status.get("result") != "SUCCESS":
            fail("Jenkins build #%s finished with %r" % (build, status.get("result")))
        return True

    wait_for(limit, "to finish", complete)
    artifact = request(client, job + "/%s/artifact/release/accepted.json" % build, limit=limit)
    if artifact.getcode() != 200:
        fail("Jenkins did not archive an accepted release receipt")
    try:
        validate_receipt(json.loads(artifact.read().decode("utf-8")), revision)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("accepted release artifact is invalid JSON")
    print("BoomPay and nixc.us SnappyMail accepted revision=%s" % revision, flush=True)


def main(revision: str, resumed_build: int | None = None) -> None:
    if not REVISION_RE.fullmatch(revision):
        fail("revision must be one full lowercase Git commit ID")
    base = base_url()
    job = base + JOB_PATH
    client = opener(base)
    limit = release_deadline()
    if resumed_build is not None:
        print("Resuming SnappyMail Jenkins build #%s monitoring" % resumed_build, flush=True)
        monitor(client, job, revision, resumed_build, limit)
        return
    existing = find_existing(client, base, job, revision, limit)
    if existing:
        kind, handle = existing
        if kind == "build":
            build = int(handle)
            print("Attaching to existing SnappyMail Jenkins build #%s" % build, flush=True)
        else:
            queue_path = str(handle)
            print("Attaching to existing SnappyMail Jenkins queue item", flush=True)

            def existing_queued_build():
                queued = queued_item_build(client, base, job, queue_path, revision, limit)
                if queued is None:
                    fail("attached Jenkins queue item no longer binds the requested revision")
                return queued or None

            build = wait_for(limit, "existing queue item to start", existing_queued_build)
            print("SnappyMail Jenkins build #%s started" % build, flush=True)
        monitor(client, job, revision, build, limit)
        return
    crumb = object_json(client, base + "/crumbIssuer/api/json", limit)
    field, value = crumb.get("crumbRequestField"), crumb.get("crumb")
    if not isinstance(field, str) or not isinstance(value, str) or not field or not value or "\n" in field + value or "\r" in field + value:
        fail("Jenkins returned an invalid CSRF crumb")
    trigger = request(client, job + "/buildWithParameters", method="POST",
                      data=urlencode({"EXPECTED_REVISION": revision}).encode("ascii"),
                      headers={field: value, "Content-Type": "application/x-www-form-urlencoded"}, limit=limit)
    if trigger.getcode() not in {201, 302}:
        fail("Jenkins rejected the build trigger with HTTP %s" % trigger.getcode())
    location = trigger.headers.get("Location", "")
    parsed = urlparse(location)
    queue = QUEUE_RE.fullmatch(parsed.path)
    if not same_origin(location, base) or not queue or parsed.query or parsed.fragment:
        fail("Jenkins returned an invalid queue location for the fixed SnappyMail job")
    print("SnappyMail Jenkins release queued", flush=True)

    def started_build():
        queued = queued_item_build(client, base, job, parsed.path, revision, limit)
        if queued is None:
            fail("Jenkins queue item does not bind the requested revision")
        return queued or None

    build = wait_for(limit, "to start", started_build)
    print("SnappyMail Jenkins build #%s started" % build, flush=True)
    monitor(client, job, revision, build, limit)


if __name__ == "__main__":
    os.umask(0o077)
    if len(sys.argv) not in {2, 3}:
        fail("usage: jenkins-release.py REVISION [BUILD_NUMBER]")
    resumed = None
    if len(sys.argv) == 3:
        if not re.fullmatch(r"[1-9][0-9]*", sys.argv[2]):
            fail("BUILD_NUMBER must be a positive integer")
        resumed = int(sys.argv[2])
    main(sys.argv[1], resumed)
