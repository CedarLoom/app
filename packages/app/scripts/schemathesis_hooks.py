"""Schemathesis hooks for the gate: every undo case that carries a well-formed run id gets a freshly recorded run."""

import atexit
import collections
import json
import os
import re
import urllib.request

import schemathesis

UNDO = "/api/runs/{id}/undo"
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
HASH = re.compile(r"[0-9a-f]{64}")
answers = collections.Counter()


@schemathesis.hook
def before_call(context, case, kwargs):
    # A malformed id or body is a negative case: it keeps its own 4xx answer.
    run = (case.path_parameters or {}).get("id")
    if case.operation.path != UNDO or not isinstance(run, str) or not RUN_ID.fullmatch(run):
        return
    # An undo settles the run it undoes, so each case records its own, with the plan hash its preview shows.
    with urllib.request.urlopen(os.environ["CEDARLOOM_FIXTURES"], timeout=30) as reply:
        fresh = json.load(reply)
    case.path_parameters["id"] = fresh["id"]
    if isinstance(case.body, dict) and set(case.body) == {"planHash"} and HASH.fullmatch(str(case.body["planHash"])):
        case.body["planHash"] = fresh["planHash"]


@schemathesis.hook
def after_call(context, case, response):
    if case.operation.path == UNDO:
        answers[(case.method, response.status_code)] += 1


@atexit.register
def report():
    print("undo answers (method, status: count):", dict(sorted(answers.items())))
