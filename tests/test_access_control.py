import json
import os
import sys
import tempfile
import traceback
from urllib.parse import urlsplit
import starlette.concurrency
import fastapi.routing
import fastapi.concurrency
import fastapi.dependencies.utils

async def _inline_threadpool(func, *args, **kwargs):
    return func(*args, **kwargs)

starlette.concurrency.run_in_threadpool = _inline_threadpool
fastapi.routing.run_in_threadpool = _inline_threadpool
fastapi.concurrency.run_in_threadpool = _inline_threadpool
fastapi.dependencies.utils.run_in_threadpool = _inline_threadpool


def _drive_coroutine(coro):
    """Drive a pure-in-memory ASGI coroutine to completion without creating OS sockets."""
    try:
        while True:
            coro.send(None)
    except StopIteration as stop:
        return stop.value

try:
    import pytest
except ImportError:
    pytest = None

# Add project root to sys.path so we can import app
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import app as quantfolio_app


class ASGIResponse:
    def __init__(self, status_code: int, headers: dict, body: bytes):
        self.status_code = status_code
        self.headers = headers
        self.body = body
        self.text = body.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.text)


class ASGITestClient:
    """In-process ASGI client for FastAPI (works with or without httpx installed)."""

    def __init__(self, app):
        self.app = app

    def request(self, method: str, url: str, headers: dict = None, json_body: dict = None) -> ASGIResponse:
        parsed = urlsplit(url)
        path = parsed.path or "/"
        query_string = (parsed.query or "").encode("utf-8")

        raw_headers = [(b"host", b"testserver")]
        if json_body is not None:
            body_bytes = json.dumps(json_body).encode("utf-8")
            raw_headers.append((b"content-type", b"application/json"))
        else:
            body_bytes = b""

        if headers:
            for k, v in headers.items():
                raw_headers.append((k.lower().encode("utf-8"), str(v).encode("utf-8")))

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method.upper(),
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("utf-8"),
            "query_string": query_string,
            "headers": raw_headers,
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }

        status_code = 500
        resp_headers = {}
        resp_chunks = []
        body_sent = False

        async def receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": body_bytes, "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message):
            nonlocal status_code, resp_headers
            if message["type"] == "http.response.start":
                status_code = message["status"]
                resp_headers = {
                    k.decode("utf-8", errors="replace").lower(): v.decode("utf-8", errors="replace")
                    for k, v in message.get("headers", [])
                }
            elif message["type"] == "http.response.body":
                resp_chunks.append(message.get("body", b""))

        try:
            from starlette.testclient import TestClient
            tc = TestClient(self.app, base_url="http://testserver", raise_server_exceptions=False)
            r = tc.request(method, url, headers=headers, json=json_body)
            return ASGIResponse(r.status_code, dict(r.headers), r.content)
        except Exception:
            _drive_coroutine(self.app(scope, receive, send))
            return ASGIResponse(status_code, resp_headers, b"".join(resp_chunks))

    def get(self, url: str, headers: dict = None) -> ASGIResponse:
        return self.request("GET", url, headers=headers)

    def post(self, url: str, headers: dict = None, json: dict = None) -> ASGIResponse:
        return self.request("POST", url, headers=headers, json_body=json)

    def put(self, url: str, headers: dict = None, json: dict = None) -> ASGIResponse:
        return self.request("PUT", url, headers=headers, json_body=json)

    def delete(self, url: str, headers: dict = None) -> ASGIResponse:
        return self.request("DELETE", url, headers=headers)


def _setup_test_environment(temp_db_file: str):
    """
    Point app._get_db_file_path to an isolated temporary JSON file,
    register User A and User B via /api/auth/login, and have User A create a portfolio.
    """
    quantfolio_app._get_db_file_path = lambda: str(temp_db_file)
    client = ASGITestClient(quantfolio_app.app)

    # 1. Register / Login User A
    res_a = client.post(
        "/api/auth/login",
        json={
            "email": "alice@example.com",
            "password": "AliceStrongPassword!123",
            "full_name": "Alice Investor",
            "mode": "signup",
        },
    )
    assert res_a.status_code == 200, f"User A signup failed: {res_a.text}"
    data_a = res_a.json()
    user_a = data_a["user"]
    token_a = data_a.get("token") or data_a.get("access_token")
    headers_a = {"Authorization": f"Bearer {token_a}"} if token_a else {}

    # 2. Register / Login User B
    res_b = client.post(
        "/api/auth/login",
        json={
            "email": "bob@example.com",
            "password": "BobStrongPassword!456",
            "full_name": "Bob Attacker",
            "mode": "signup",
        },
    )
    assert res_b.status_code == 200, f"User B signup failed: {res_b.text}"
    data_b = res_b.json()
    user_b = data_b["user"]
    token_b = data_b.get("token") or data_b.get("access_token")
    headers_b = {"Authorization": f"Bearer {token_b}"} if token_b else {}

    # 3. User A creates a private portfolio
    create_res = client.post(
        "/api/portfolios",
        headers=headers_a,
        json={
            "user_id": user_a["id"],
            "email": user_a["email"],
            "portfolio_name": "Alice Secret Retirement Portfolio",
            "goal_type": "retirement",
            "target_amount": 5000000.0,
            "initial_budget": 500000.0,
            "monthly_dca": 15000.0,
            "investment_period_years": 10,
            "currency": "THB",
            "tickers": ["AAPL", "MSFT", "NVDA"],
            "asset_weights": {"AAPL": 40.0, "MSFT": 35.0, "NVDA": 25.0},
            "strategy_key": "max_sharpe",
        },
    )
    assert create_res.status_code == 200, f"User A portfolio creation failed: {create_res.text}"
    portfolio_a = create_res.json()["portfolio"]

    return {
        "client": client,
        "user_a": user_a,
        "headers_a": headers_a,
        "portfolio_a": portfolio_a,
        "user_b": user_b,
        "headers_b": headers_b,
    }


if pytest is not None:
    @pytest.fixture()
    def client_and_users(tmp_path):
        orig_fn = quantfolio_app._get_db_file_path
        try:
            yield _setup_test_environment(str(tmp_path / "test_quantfolio_users_db.json"))
        finally:
            quantfolio_app._get_db_file_path = orig_fn


def test_unauthenticated_requests_are_rejected(client_and_users):
    """Unauthenticated or tampered token requests to GET/POST/PUT/DELETE /api/portfolios must return 401."""
    client = client_and_users["client"]
    user_a = client_and_users["user_a"]
    portfolio_a = client_and_users["portfolio_a"]

    res_get = client.get(f"/api/portfolios?user_id={user_a['id']}&email={user_a['email']}")
    assert res_get.status_code == 401, (
        f"VULNERABILITY: Expected 401 on unauthenticated GET, got {res_get.status_code}: {res_get.text}"
    )

    res_get_by_id = client.get(f"/api/portfolios/{portfolio_a['id']}")
    assert res_get_by_id.status_code == 401, (
        f"VULNERABILITY: Expected 401 on unauthenticated GET by ID, got {res_get_by_id.status_code}"
    )

    res_post = client.post(
        "/api/portfolios",
        json={
            "user_id": user_a["id"],
            "portfolio_name": "Unauth Injected Portfolio",
        },
    )
    assert res_post.status_code == 401, (
        f"VULNERABILITY: Expected 401 on unauthenticated POST, got {res_post.status_code}: {res_post.text}"
    )

    res_put = client.put(
        f"/api/portfolios/{portfolio_a['id']}",
        json={"portfolio_name": "Unauth Put"},
    )
    assert res_put.status_code == 401, (
        f"VULNERABILITY: Expected 401 on unauthenticated PUT, got {res_put.status_code}: {res_put.text}"
    )

    res_delete = client.delete(f"/api/portfolios/{portfolio_a['id']}?user_id={user_a['id']}")
    assert res_delete.status_code == 401, (
        f"VULNERABILITY: Expected 401 on unauthenticated DELETE, got {res_delete.status_code}: {res_delete.text}"
    )

    # Tampered signature must also return 401
    tampered_headers = {"Authorization": client_and_users["headers_a"]["Authorization"][:-4] + "0000"}
    res_tampered = client.get("/api/portfolios", headers=tampered_headers)
    assert res_tampered.status_code == 401


def test_user_b_cannot_get_user_a_portfolios(client_and_users):
    """
    User B attempts to GET User A's portfolios by passing User A's user_id and email,
    or by requesting /api/portfolios/{portfolio_a_id}.
    Must return 404 identically for both User A's portfolio ID and a non-existent ID,
    and GET /api/portfolios must ignore query params and never return User A's portfolio.
    """
    client = client_and_users["client"]
    user_a = client_and_users["user_a"]
    portfolio_a = client_and_users["portfolio_a"]
    headers_b = client_and_users["headers_b"]

    res = client.get(
        f"/api/portfolios?user_id={user_a['id']}&email={user_a['email']}",
        headers=headers_b,
    )
    assert res.status_code == 200
    returned_ids = [p.get("id") for p in res.json().get("portfolios", [])]
    assert portfolio_a["id"] not in returned_ids, (
        f"VULNERABILITY: User B read User A's portfolio {portfolio_a['id']} via GET /api/portfolios! "
        f"Returned: {res.text}"
    )

    # Direct GET by ID: must return 404 identically for User A's portfolio and non-existent ID
    res_a_id = client.get(f"/api/portfolios/{portfolio_a['id']}", headers=headers_b)
    res_nonexistent = client.get("/api/portfolios/00000000-0000-0000-0000-000000000000", headers=headers_b)
    assert res_a_id.status_code == 404
    assert res_nonexistent.status_code == 404
    assert res_a_id.json() == res_nonexistent.json()


def test_user_b_cannot_put_or_overwrite_user_a_portfolio(client_and_users):
    """
    User B attempts to overwrite User A's portfolio via POST /api/portfolios (with id=portfolio_a['id'])
    and via PUT /api/portfolios/{portfolio_a['id']}.
    Must return 404 identically for both User A's portfolio and a non-existent portfolio,
    and leave User A's portfolio untouched.
    """
    client = client_and_users["client"]
    user_a = client_and_users["user_a"]
    headers_a = client_and_users["headers_a"]
    portfolio_a = client_and_users["portfolio_a"]
    user_b = client_and_users["user_b"]
    headers_b = client_and_users["headers_b"]

    attack_payload = {
        "id": portfolio_a["id"],
        "user_id": user_b["id"],
        "email": user_b["email"],
        "portfolio_name": "HACKED BY BOB",
        "target_amount": 1.0,
    }

    # 1. Try overwriting via POST /api/portfolios with id=portfolio_a["id"]
    res_post_overwrite = client.post(
        "/api/portfolios",
        headers=headers_b,
        json=attack_payload,
    )
    assert res_post_overwrite.status_code == 404, (
        f"VULNERABILITY: Expected 404 when User B overwrites User A's portfolio via POST, "
        f"got {res_post_overwrite.status_code}: {res_post_overwrite.text}"
    )

    # 2. Try PUT /api/portfolios/{id} on User A's portfolio vs non-existent ID
    res_put = client.put(
        f"/api/portfolios/{portfolio_a['id']}",
        headers=headers_b,
        json=attack_payload,
    )
    res_put_nonexistent = client.put(
        "/api/portfolios/00000000-0000-0000-0000-000000000000",
        headers=headers_b,
        json=attack_payload,
    )
    assert res_put.status_code == 404, (
        f"VULNERABILITY: Expected 404 on cross-user PUT, got {res_put.status_code}: {res_put.text}"
    )
    assert res_put_nonexistent.status_code == 404
    assert res_put.json() == res_put_nonexistent.json()

    # Verify User A's portfolio is still intact
    res_a_check = client.get(f"/api/portfolios?user_id={user_a['id']}", headers=headers_a)
    assert res_a_check.status_code == 200
    portfolios_a = res_a_check.json()["portfolios"]
    assert len(portfolios_a) == 1
    assert portfolios_a[0]["portfolio_name"] == "Alice Secret Retirement Portfolio"
    assert portfolios_a[0]["user_id"] == user_a["id"]


def test_user_b_cannot_delete_user_a_portfolio(client_and_users):
    """
    User B attempts to DELETE User A's portfolio (/api/portfolios/{portfolio_a_id}).
    Must return 404 identically for both User A's portfolio and a non-existent portfolio,
    and User A's portfolio must NOT be deleted.
    """
    client = client_and_users["client"]
    user_a = client_and_users["user_a"]
    headers_a = client_and_users["headers_a"]
    portfolio_a = client_and_users["portfolio_a"]
    user_b = client_and_users["user_b"]
    headers_b = client_and_users["headers_b"]

    res_del = client.delete(
        f"/api/portfolios/{portfolio_a['id']}?user_id={user_b['id']}",
        headers=headers_b,
    )
    res_del_nonexistent = client.delete(
        "/api/portfolios/00000000-0000-0000-0000-000000000000",
        headers=headers_b,
    )
    assert res_del.status_code == 404, (
        f"VULNERABILITY: Expected 404 when User B deletes User A's portfolio, "
        f"got {res_del.status_code}: {res_del.text}"
    )
    assert res_del_nonexistent.status_code == 404
    assert res_del.json() == res_del_nonexistent.json()

    # Verify User A's portfolio still exists
    res_a_check = client.get(f"/api/portfolios?user_id={user_a['id']}", headers=headers_a)
    assert res_a_check.status_code == 200
    portfolios_a = res_a_check.json()["portfolios"]
    assert len(portfolios_a) == 1
    assert portfolios_a[0]["id"] == portfolio_a["id"]


def test_user_b_post_spoofing_user_a_id_is_ignored_or_rejected(client_and_users):
    """
    User B sends POST /api/portfolios while sneaking User A's user_id and email in the request body.
    The server must either reject the request (401/403/400) OR ignore the client-supplied user_id/email
    and bind the portfolio strictly to User B's authenticated identity.
    """
    client = client_and_users["client"]
    user_a = client_and_users["user_a"]
    headers_a = client_and_users["headers_a"]
    user_b = client_and_users["user_b"]
    headers_b = client_and_users["headers_b"]

    res_spoof = client.post(
        "/api/portfolios",
        headers=headers_b,
        json={
            "user_id": user_a["id"],
            "email": user_a["email"],
            "portfolio_name": "Fake Portfolio Injected Into Alice Account",
            "target_amount": 999999.0,
        },
    )

    if res_spoof.status_code == 200:
        saved_p = res_spoof.json()["portfolio"]
        assert saved_p["user_id"] == user_b["id"], (
            f"VULNERABILITY: Server accepted spoofed user_id={saved_p['user_id']} "
            f"instead of authenticated User B ({user_b['id']})!"
        )
        assert saved_p["email"] == user_b["email"]
    else:
        assert res_spoof.status_code in (400, 401, 403, 404)

    # Verify Alice's account does NOT have the spoofed portfolio
    res_a_check = client.get(f"/api/portfolios?user_id={user_a['id']}", headers=headers_a)
    assert res_a_check.status_code == 200
    names_a = [p["portfolio_name"] for p in res_a_check.json()["portfolios"]]
    assert "Fake Portfolio Injected Into Alice Account" not in names_a


def test_legitimate_owner_crud_flow(client_and_users):
    """
    Verify that User A can GET, PUT/update, and DELETE her own portfolio using her verified token.
    """
    client = client_and_users["client"]
    user_a = client_and_users["user_a"]
    headers_a = client_and_users["headers_a"]
    portfolio_a = client_and_users["portfolio_a"]

    # 1. GET by ID
    res_get_one = client.get(f"/api/portfolios/{portfolio_a['id']}", headers=headers_a)
    assert res_get_one.status_code == 200
    assert res_get_one.json()["portfolio"]["id"] == portfolio_a["id"]

    # 2. PUT update own portfolio
    res_put_own = client.put(
        f"/api/portfolios/{portfolio_a['id']}",
        headers=headers_a,
        json={
            "portfolio_name": "Alice Updated Portfolio",
            "target_amount": 7500000.0,
        },
    )
    assert res_put_own.status_code == 200
    assert res_put_own.json()["portfolio"]["portfolio_name"] == "Alice Updated Portfolio"
    assert res_put_own.json()["portfolio"]["user_id"] == user_a["id"]

    # 3. DELETE own portfolio
    res_del_own = client.delete(f"/api/portfolios/{portfolio_a['id']}", headers=headers_a)
    assert res_del_own.status_code == 200
    assert res_del_own.json()["deleted"] == 1

    # 4. Subsequent GET by ID returns 404
    res_after_del = client.get(f"/api/portfolios/{portfolio_a['id']}", headers=headers_a)
    assert res_after_del.status_code == 404


if __name__ == "__main__":
    test_funcs = [
        test_unauthenticated_requests_are_rejected,
        test_user_b_cannot_get_user_a_portfolios,
        test_user_b_cannot_put_or_overwrite_user_a_portfolio,
        test_user_b_cannot_delete_user_a_portfolio,
        test_user_b_post_spoofing_user_a_id_is_ignored_or_rejected,
        test_legitimate_owner_crud_flow,
    ]
    print("============================= test session starts =============================")
    print(f"collected {len(test_funcs)} items\n")
    passed = 0
    failed = 0
    failures = []
    orig_db_fn = quantfolio_app._get_db_file_path
    for fn in test_funcs:
        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                ctx = _setup_test_environment(os.path.join(tmpdir, "test_quantfolio_users_db.json"))
                fn(ctx)
                print(f"tests/test_access_control.py::{fn.__name__} PASSED")
                passed += 1
            except AssertionError as e:
                print(f"tests/test_access_control.py::{fn.__name__} FAILED")
                failed += 1
                failures.append((fn.__name__, str(e)))
            except Exception as e:
                print(f"tests/test_access_control.py::{fn.__name__} ERROR")
                failed += 1
                failures.append((fn.__name__, traceback.format_exc()))
            finally:
                quantfolio_app._get_db_file_path = orig_db_fn

    if failures:
        print("\n================================== FAILURES ===================================")
        for name, msg in failures:
            print(f"_______________________ {name} _______________________")
            print(f"AssertionError: {msg}\n")
    print(f"=========================== {failed} failed, {passed} passed ===========================")
    sys.exit(1 if failed > 0 else 0)
