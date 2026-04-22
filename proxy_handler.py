#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
proxy_handler.py -- Parse PROXY_URL and generate sing-box config.json

Supported protocols:
  socks5://[user:pass@]host:port
  http://[user:pass@]host:port
  https://[user:pass@]host:port
  vless://uuid@host:port?security=tls&type=ws&...#name
  vmess://base64EncodedJSON
  hy2://password@host:port?sni=xxx&insecure=1
  hysteria2://password@host:port?sni=xxx
  tuic://uuid:password@host:port?sni=xxx&alpn=h3&congestion_control=bbr

Output: config.json with HTTP inbound on 127.0.0.1:8080
"""

import os
import sys
import json
import base64
from urllib.parse import urlparse, parse_qs, unquote

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8080


# ============================================================
# Protocol Parsers
# ============================================================

def parse_socks5(parsed):
    outbound = {
        "type": "socks",
        "tag": "proxy",
        "server": parsed.hostname,
        "server_port": parsed.port or 1080,
        "version": "5",
    }
    if parsed.username:
        outbound["username"] = unquote(parsed.username)
    if parsed.password:
        outbound["password"] = unquote(parsed.password)
    return outbound


def parse_http(parsed):
    outbound = {
        "type": "http",
        "tag": "proxy",
        "server": parsed.hostname,
        "server_port": parsed.port or 8080,
    }
    if parsed.username:
        outbound["username"] = unquote(parsed.username)
    if parsed.password:
        outbound["password"] = unquote(parsed.password)
    if parsed.scheme == "https":
        outbound["tls"] = {"enabled": True}
    return outbound


def parse_vless(parsed, params):
    outbound = {
        "type": "vless",
        "tag": "proxy",
        "server": parsed.hostname,
        "server_port": parsed.port or 443,
        "uuid": parsed.username,
    }

    # Flow (e.g. xtls-rprx-vision)
    flow = params.get("flow", [""])[0]
    if flow:
        outbound["flow"] = flow

    # TLS / REALITY
    security = params.get("security", [""])[0]
    if security in ("tls", "reality"):
        tls = {"enabled": True}

        sni = params.get("sni", [""])[0]
        if sni:
            tls["server_name"] = sni

        fp = params.get("fp", [""])[0]
        if fp:
            tls["utls"] = {"enabled": True, "fingerprint": fp}

        alpn = params.get("alpn", [""])[0]
        if alpn:
            tls["alpn"] = alpn.split(",")

        insecure = params.get("insecure", params.get("allowInsecure", ["0"]))[0]
        if insecure == "1":
            tls["insecure"] = True

        if security == "reality":
            reality = {"enabled": True}
            pbk = params.get("pbk", [""])[0]
            if pbk:
                reality["public_key"] = pbk
            sid = params.get("sid", [""])[0]
            if sid:
                reality["short_id"] = sid
            tls["reality"] = reality

        outbound["tls"] = tls

    # Transport
    net_type = params.get("type", [""])[0]
    if net_type == "ws":
        transport = {"type": "ws"}
        path = params.get("path", [""])[0]
        if path:
            transport["path"] = unquote(path)
        host = params.get("host", [""])[0]
        if host:
            transport["headers"] = {"Host": host}
        outbound["transport"] = transport
    elif net_type == "grpc":
        transport = {"type": "grpc"}
        sn = params.get("serviceName", [""])[0]
        if sn:
            transport["service_name"] = sn
        outbound["transport"] = transport
    elif net_type in ("http", "h2"):
        transport = {"type": "http"}
        path = params.get("path", [""])[0]
        if path:
            transport["path"] = unquote(path)
        host = params.get("host", [""])[0]
        if host:
            transport["host"] = [host]
        outbound["transport"] = transport

    return outbound


def parse_vmess(url_str):
    encoded = url_str[len("vmess://"):]
    # Fix base64 padding
    pad = 4 - len(encoded) % 4
    if pad != 4:
        encoded += "=" * pad
    decoded = base64.b64decode(encoded).decode("utf-8")
    cfg = json.loads(decoded)

    outbound = {
        "type": "vmess",
        "tag": "proxy",
        "server": cfg.get("add", ""),
        "server_port": int(cfg.get("port", 443)),
        "uuid": cfg.get("id", ""),
        "security": cfg.get("scy", "auto"),
        "alter_id": int(cfg.get("aid", 0)),
    }

    # TLS
    if cfg.get("tls") == "tls":
        tls = {"enabled": True}
        sni = cfg.get("sni", "")
        if sni:
            tls["server_name"] = sni
        elif cfg.get("host"):
            tls["server_name"] = cfg["host"]
        alpn = cfg.get("alpn", "")
        if alpn:
            tls["alpn"] = alpn.split(",")
        outbound["tls"] = tls

    # Transport
    net = cfg.get("net", "tcp")
    if net == "ws":
        transport = {"type": "ws"}
        if cfg.get("path"):
            transport["path"] = cfg["path"]
        if cfg.get("host"):
            transport["headers"] = {"Host": cfg["host"]}
        outbound["transport"] = transport
    elif net == "grpc":
        transport = {"type": "grpc"}
        if cfg.get("path"):
            transport["service_name"] = cfg["path"]
        outbound["transport"] = transport
    elif net in ("h2", "http"):
        transport = {"type": "http"}
        if cfg.get("path"):
            transport["path"] = cfg["path"]
        if cfg.get("host"):
            transport["host"] = [cfg["host"]]
        outbound["transport"] = transport

    return outbound


def parse_hysteria2(parsed, params):
    outbound = {
        "type": "hysteria2",
        "tag": "proxy",
        "server": parsed.hostname,
        "server_port": parsed.port or 443,
        "password": unquote(parsed.username or ""),
    }

    tls = {"enabled": True}
    sni = params.get("sni", [""])[0]
    if sni:
        tls["server_name"] = sni
    insecure = params.get("insecure", params.get("allowInsecure", ["0"]))[0]
    if insecure == "1":
        tls["insecure"] = True
    alpn = params.get("alpn", [""])[0]
    if alpn:
        tls["alpn"] = alpn.split(",")
    outbound["tls"] = tls

    # Obfuscation (optional)
    obfs = params.get("obfs", [""])[0]
    if obfs:
        obfs_pwd = params.get("obfs-password", [""])[0]
        outbound["obfs"] = {"type": obfs, "password": obfs_pwd}

    return outbound


def parse_tuic(parsed, params):
    outbound = {
        "type": "tuic",
        "tag": "proxy",
        "server": parsed.hostname,
        "server_port": parsed.port or 443,
        "uuid": "",
        "password": "",
        "congestion_control": params.get("congestion_control", ["bbr"])[0],
    }

    user_part = unquote(parsed.username or "")
    pass_part = unquote(parsed.password or "")

    if ":" in user_part and not pass_part:
        outbound["uuid"], outbound["password"] = user_part.split(":", 1)
    else:
        outbound["uuid"] = user_part
        outbound["password"] = pass_part

    tls = {"enabled": True}
    sni = params.get("sni", [""])[0]
    if sni:
        tls["server_name"] = sni
    insecure = params.get("insecure", params.get("allowInsecure", ["0"]))[0]
    if insecure == "1":
        tls["insecure"] = True
    alpn = params.get("alpn", [""])[0]
    if alpn:
        tls["alpn"] = alpn.split(",")
    outbound["tls"] = tls

    return outbound


# ============================================================
# Main
# ============================================================

def main():
    proxy_url = os.environ.get("PROXY_URL", "").strip()
    if not proxy_url:
        print("PROXY_URL is empty, skipping sing-box config generation.")
        sys.exit(0)

    scheme = proxy_url.split("://")[0].lower()
    print(f"Parsing proxy URI ({scheme}://***)")

    if scheme == "vmess":
        outbound = parse_vmess(proxy_url)
    else:
        parsed = urlparse(proxy_url)
        params = parse_qs(parsed.query)

        if scheme == "socks5":
            outbound = parse_socks5(parsed)
        elif scheme in ("http", "https"):
            outbound = parse_http(parsed)
        elif scheme == "vless":
            outbound = parse_vless(parsed, params)
        elif scheme in ("hy2", "hysteria2"):
            outbound = parse_hysteria2(parsed, params)
        elif scheme == "tuic":
            outbound = parse_tuic(parsed, params)
        else:
            print(f"Unsupported protocol: {scheme}")
            sys.exit(1)

    config = {
        "log": {"level": "info", "timestamp": True},
        "inbounds": [
            {
                "type": "http",
                "tag": "http-in",
                "listen": LISTEN_HOST,
                "listen_port": LISTEN_PORT,
            }
        ],
        "outbounds": [
            outbound,
            {"type": "direct", "tag": "direct"},
        ],
    }

    with open("config.json", "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    server = outbound.get("server", "N/A")
    port = outbound.get("server_port", "N/A")
    print(f"sing-box config.json generated.")
    print(f"  Inbound: http://{LISTEN_HOST}:{LISTEN_PORT}")
    print(f"  Outbound: {outbound['type']} -> {server}:{port}")


if __name__ == "__main__":
    main()
