"""zcode-relay 核心控制面客户端。

核心模式下，面板只调用这里的内部 API，不再把账号凭证写入本地 SQLite。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import Request
from fastapi.responses import StreamingResponse


class CoreUnavailable(RuntimeError):
    """核心不可用或返回了管理面错误。"""


class CoreClient:
    def __init__(
        self,
        base_url: str,
        admin_key: str,
        *,
        control_url: str | None = None,
        proxy_key: str = "",
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.control_url = (control_url or base_url).rstrip("/")
        self.admin_key = admin_key
        self.proxy_key = proxy_key
        self.timeout = timeout
        self.transport = transport

    def _headers(self, *, admin: bool = False, proxy: bool = False) -> dict[str, str]:
        headers: dict[str, str] = {}
        if admin:
            headers["authorization"] = f"Bearer {self.admin_key}"
        if proxy and self.proxy_key:
            headers["authorization"] = f"Bearer {self.proxy_key}"
        return headers

    def _make_client(self, *, control: bool = False) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.control_url if control else self.base_url, timeout=self.timeout, transport=self.transport)

    async def _json_request(self, method: str, path: str, *, json: Any = None) -> dict[str, Any]:
        try:
            async with self._make_client(control=True) as client:
                response = await client.request(method, path, headers=self._headers(admin=True), json=json)
        except httpx.HTTPError as error:
            raise CoreUnavailable(f"核心不可用: {error}") from error
        if response.status_code >= 400:
            message = _error_message(response)
            raise CoreUnavailable(f"核心不可用: HTTP {response.status_code} {message}")
        try:
            value = response.json()
        except ValueError as error:
            raise CoreUnavailable("核心不可用: 返回不是合法 JSON") from error
        if not isinstance(value, dict):
            raise CoreUnavailable("核心不可用: 返回结构无效")
        return value

    async def health(self) -> dict[str, Any]:
        return await self._json_request("GET", "/internal/health")

    async def models(self) -> dict[str, Any]:
        try:
            async with self._make_client() as client:
                response = await client.get("/v1/models", headers=self._headers(proxy=True))
        except httpx.HTTPError as error:
            raise CoreUnavailable(f"核心不可用: {error}") from error
        if response.status_code >= 400:
            raise CoreUnavailable(f"核心不可用: HTTP {response.status_code} {_error_message(response)}")
        value = response.json()
        if not isinstance(value, dict):
            raise CoreUnavailable("核心不可用: 返回结构无效")
        return value

    async def runtime(self) -> dict[str, Any]:
        return await self._json_request("GET", "/internal/runtime")

    async def list_accounts(self) -> dict[str, Any]:
        return _map_accounts(await self._json_request("GET", "/internal/accounts"))

    async def add_accounts(self, provider: str, tokens: list[str], name: str | None = None) -> dict[str, Any]:
        ids: list[str] = []
        for index, token in enumerate(dict.fromkeys(t.strip() for t in tokens if t and t.strip())):
            payload: dict[str, Any] = {"provider": provider, "credential": token}
            if name and len(tokens) == 1:
                payload["id"] = name.strip()
            elif name:
                payload["id"] = f"{name.strip()}-{index + 1}"
            result = await self._json_request("POST", "/internal/accounts", json=payload)
            account = result.get("account") or {}
            if isinstance(account, dict) and isinstance(account.get("id"), str):
                ids.append(account["id"])
        return {"count": len(ids), "ids": ids}

    async def edit_account(self, account_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        core_payload: dict[str, Any] = {}
        if payload.get("token") or payload.get("secret"):
            core_payload["credential"] = payload.get("token") or payload.get("secret")
        if payload.get("mode") in ("apikey", "oauth"):
            core_payload["mode"] = payload["mode"]
        return await self._json_request("PUT", f"/internal/accounts/{account_id}", json=core_payload)

    async def delete_accounts(self, ids: list[str]) -> dict[str, int]:
        deleted = 0
        for account_id in ids:
            try:
                await self._json_request("DELETE", f"/internal/accounts/{account_id}")
                deleted += 1
            except CoreUnavailable as error:
                if "HTTP 404" in str(error):
                    continue
                raise
        return {"deleted": deleted}

    async def set_enabled(self, account_id: str, enabled: bool) -> dict[str, Any]:
        return await self._json_request("POST", f"/internal/accounts/{account_id}/{'enable' if enabled else 'disable'}")

    async def refresh(self, account_id: str | None = None) -> dict[str, Any]:
        if account_id:
            return await self._json_request("POST", f"/internal/accounts/{account_id}/check")
        result = await self._json_request("POST", "/internal/accounts/check")
        accounts = result.get("accounts") if isinstance(result.get("accounts"), list) else []
        return {**result, "summary": {"ok": len(accounts), "fail": 0}, "count": len(accounts)}

    async def status(self) -> dict[str, Any]:
        runtime = await self.runtime()
        pool = runtime.get("pool") or {}
        return {
            "providers": ["zai", "bigmodel"],
            "gateway_key_set": bool(self.proxy_key),
            "quota_pool": {"zai": _provider_selectable(pool, "zai"), "bigmodel": _provider_selectable(pool, "bigmodel")},
            "core": runtime,
        }

    async def proxy(self, request: Request, path: str) -> StreamingResponse:
        body = await request.body()
        headers = _forward_headers(request)
        headers.update(self._headers(proxy=True))
        client = self._make_client()
        stream_context = client.stream(request.method, path, headers=headers, content=body)
        try:
            response = await stream_context.__aenter__()
        except httpx.HTTPError as error:
            await client.aclose()
            raise CoreUnavailable(f"核心不可用: {error}") from error

        async def body_iterator() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await stream_context.__aexit__(None, None, None)
                await client.aclose()

        response_headers = {
            key: value
            for key, value in response.headers.items()
            if key.lower() in {"content-type", "cache-control", "content-encoding", "x-request-id", "retry-after"}
        }
        return StreamingResponse(body_iterator(), status_code=response.status_code, headers=response_headers)


def _map_accounts(payload: dict[str, Any]) -> dict[str, Any]:
    raw_accounts = payload.get("accounts") if isinstance(payload.get("accounts"), list) else []
    accounts = [_map_account(item) for item in raw_accounts if isinstance(item, dict)]
    stats = {"total": len(accounts), "active": 0, "exhausted": 0, "cooling": 0, "invalid": 0, "disabled": 0, "calls": 0, "fail": 0}
    for account in accounts:
        status = account["status"]
        if status in stats:
            stats[status] += 1
        stats["calls"] += account["use_count"]
        stats["fail"] += account["fail_count"]
    return {"accounts": accounts, "stats": stats, "providers": ["zai", "bigmodel"], "ts": payload.get("ts")}


def _map_account(account: dict[str, Any]) -> dict[str, Any]:
    mode = "jwt" if account.get("mode") == "oauth" else "apiKey"
    last_success = account.get("lastSuccessAt")
    last_failure = account.get("lastFailureAt")
    return {
        "id": account.get("id"),
        "name": account.get("id"),
        "provider": account.get("provider"),
        "mode": mode,
        "token_masked": account.get("credentialMasked", "********"),
        "enabled": bool(account.get("enabled", False)),
        "status": account.get("status", "active"),
        "quota": _map_quota(account.get("quota")),
        "plan": {},
        "usage": {},
        "use_count": int(account.get("requestCount", 0) or 0),
        "fail_count": int(account.get("failureCount", 0) or 0),
        "usage_tokens": account.get("usage", {}),
        "last_used_at": last_success / 1000 if isinstance(last_success, (int, float)) else None,
        "last_checked_at": None,
        "cooling_until": account.get("coolingUntil"),
        "last_error": account.get("lastError"),
        "created_at": None,
    }


def _provider_selectable(pool: dict[str, Any], provider: str) -> int:
    # runtime summary currently exposes aggregate counts; account-level state is
    # available from /internal/accounts and this fallback remains conservative.
    if provider == pool.get("provider"):
        return int(pool.get("selectable", 0) or 0)
    return 0


def _map_quota(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("status") not in {"healthy", "exhausted"}:
        return {}
    remaining = value.get("remaining")
    limit = value.get("limit")
    used = value.get("used")
    if not any(isinstance(item, (int, float)) for item in (remaining, limit, used)):
        return {}
    return {"provider": {"total": limit, "used": used, "remaining": remaining, "expires_at": None}}


def _forward_headers(request: Request) -> dict[str, str]:
    excluded = {"host", "content-length", "connection", "authorization", "x-api-key"}
    return {key: value for key, value in request.headers.items() if key.lower() not in excluded}


def _error_message(response: httpx.Response) -> str:
    try:
        value = response.json()
        if isinstance(value, dict):
            error = value.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                return error["message"]
    except ValueError:
        pass
    return response.text[:200]
