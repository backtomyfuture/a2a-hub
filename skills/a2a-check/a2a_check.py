#!/usr/bin/env python3
# 定时门控：问 Hub 有没有属于本节点的新任务或变化。空闲打印 IDLE，有事打印 WORK。
# 只使用 Python 3 标准库。不打印 Token。UA 必须与 src/kernel-util.mjs 的 BROWSER_USER_AGENT 相同，
# 否则 Cloudflare 会用 403 / 1010 拦住默认的 python-urllib。

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
# 经 Cloudflare 的 TLS 握手偶尔要十几秒，15 秒会把正常空闲误报成 ERROR。
TIMEOUT = 25


def die(message):
    print(f"ERROR {message}")
    sys.exit(2)


def parse_args(argv):
    hub = ""
    node = ""
    token = ""
    token_file = ""
    silent = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--silent-idle":
            silent = True
            i += 1
            continue
        if arg in ("--hub", "--node", "--token", "--token-file"):
            if i + 1 >= len(argv):
                die(f"缺少 {arg} 的值")
            value = argv[i + 1]
            if arg == "--hub":
                hub = value
            elif arg == "--node":
                node = value
            elif arg == "--token":
                token = value
            else:
                token_file = value
            i += 2
            continue
        die("无法识别的参数")
    if not hub or not node:
        die("用法: a2a_check.py --hub URL --node NAME [--token-file PATH | --token VALUE] [--silent-idle]")
    return hub, node, token, token_file, silent


def load_token(token, token_file):
    # 环境变量优先，其次文件，最后才是命令行明文。都没有就空着：免鉴权 Hub 不需要钥匙。
    env = os.environ.get("A2A_HUB_TOKEN", "").strip()
    if env:
        return env
    if token_file:
        try:
            with open(token_file, encoding="utf-8") as handle:
                file_token = handle.read().strip()
        except OSError:
            die("读取 token 文件失败")
        if not file_token:
            die("token 文件为空")
        return file_token
    return token.strip()


def fail_http(code, body):
    text = body.strip()
    is_json = False
    if text:
        try:
            json.loads(text)
            is_json = True
        except json.JSONDecodeError:
            is_json = False
    if code == 1010 or "1010" in text or (code == 403 and not is_json):
        die(f"HTTP {code} 非 JSON，疑似 Cloudflare 拦截，检查 User-Agent")
    if code in (401, 403):
        die(f"HTTP {code} 未授权或禁止访问，检查 Token")
    die(f"HTTP {code}")


def main(argv):
    hub, node, token_arg, token_file, silent = parse_args(argv)
    token = load_token(token_arg, token_file)
    quoted = urllib.parse.quote(node, safe="")
    url = f"{hub.rstrip('/')}/api/v1/agents/{quoted}/check"
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
            code = getattr(resp, "status", 200) or 200
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        fail_http(exc.code, raw)
    except Exception:
        die("请求失败")
    if code != 200:
        fail_http(code, raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        fail_http(code, raw)
    if not isinstance(data, dict) or "work" not in data:
        die(f"HTTP {code} 响应缺少 work")
    if data.get("work") is True:
        print("WORK")
        print(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        return 0
    if silent:
        return 0
    print("IDLE")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
