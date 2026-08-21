import json

import httpx
import pytest
from fastapi import Request

from app.core_client import CoreClient, CoreUnavailable


@pytest.mark.asyncio
async def test_list_accounts_uses_core_key_and_maps_snapshot():
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("authorization")
        seen["port"] = request.url.port
        return httpx.Response(200, json={
            "accounts": [{
                "id": "zai-1", "provider": "zai", "mode": "apikey",
                "credentialMasked": "********", "enabled": True, "status": "active",
                "requestCount": 3, "failureCount": 1,
            }],
            "total": 1,
        })

    client = CoreClient("http://core:8080", "admin-secret", control_url="http://core:8091", transport=httpx.MockTransport(handler))
    result = await client.list_accounts()

    assert seen["authorization"] == "Bearer admin-secret"
    assert seen["port"] == 8091
    assert result["accounts"][0]["token_masked"] == "********"
    assert result["accounts"][0]["use_count"] == 3
    assert result["stats"]["fail"] == 1


@pytest.mark.asyncio
async def test_add_accounts_calls_core_without_persisting_local_tokens():
    requests = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(201, json={"account": {"id": "zai-1", "credentialMasked": "********"}})

    client = CoreClient("http://core", "admin-secret", transport=httpx.MockTransport(handler))
    result = await client.add_accounts("zai", ["secret-token"], "demo")

    assert result == {"count": 1, "ids": ["zai-1"]}
    assert requests[0][2]["credential"] == "secret-token"


@pytest.mark.asyncio
async def test_unavailable_core_is_explicit():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": {"message": "down"}})

    client = CoreClient("http://core", "admin-secret", transport=httpx.MockTransport(handler))
    with pytest.raises(CoreUnavailable, match="核心不可用"):
        await client.list_accounts()


@pytest.mark.asyncio
async def test_proxy_forwards_stream_and_replaces_client_credential():
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("authorization")
        seen["body"] = request.content
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b"data: ok\n\n")

    client = CoreClient("http://core", "admin-secret", proxy_key="proxy-secret", transport=httpx.MockTransport(handler))
    scope = {"type": "http", "method": "POST", "path": "/v1/messages", "headers": [], "query_string": b"", "server": ("panel", 80), "client": ("test", 1), "scheme": "http"}

    async def receive():
        return {"type": "http.request", "body": b"{}", "more_body": False}

    response = await client.proxy(Request(scope, receive), "/v1/messages")
    chunks = [chunk async for chunk in response.body_iterator]

    assert response.status_code == 200
    assert b"".join(chunks) == b"data: ok\n\n"
    assert seen == {"authorization": "Bearer proxy-secret", "body": b"{}"}
