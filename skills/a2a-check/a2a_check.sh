#!/bin/sh
# POSIX sh + curl 版检查脚本。约定与 a2a_check.py 相同：IDLE / WORK / ERROR。
# 不依赖 jq。UA 必须与 src/kernel-util.mjs 的 BROWSER_USER_AGENT 相同。不打印 Token。

set -eu

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
HUB=""
NODE=""
TOKEN_ARG=""
TOKEN_FILE=""
SILENT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --silent-idle)
      SILENT=1
      shift
      ;;
    --hub|--node|--token|--token-file)
      if [ $# -lt 2 ]; then
        echo "ERROR 缺少 $1 的值"
        exit 2
      fi
      case "$1" in
        --hub) HUB=$2 ;;
        --node) NODE=$2 ;;
        --token) TOKEN_ARG=$2 ;;
        --token-file) TOKEN_FILE=$2 ;;
      esac
      shift 2
      ;;
    *)
      echo "ERROR 无法识别的参数"
      exit 2
      ;;
  esac
done

if [ -z "$HUB" ] || [ -z "$NODE" ]; then
  echo "ERROR 用法: a2a_check.sh --hub URL --node NAME [--token-file PATH | --token VALUE] [--silent-idle]"
  exit 2
fi

# 环境变量优先，其次文件，最后才是命令行明文。都没有就空着，免鉴权 Hub 不带 Authorization。
TOKEN=${A2A_HUB_TOKEN-}
if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ]; then
  if [ ! -r "$TOKEN_FILE" ]; then
    echo "ERROR 读取 token 文件失败"
    exit 2
  fi
  TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
  if [ -z "$TOKEN" ]; then
    echo "ERROR token 文件为空"
    exit 2
  fi
fi
if [ -z "$TOKEN" ] && [ -n "$TOKEN_ARG" ]; then
  TOKEN=$TOKEN_ARG
fi

HUB=${HUB%/}
URL="${HUB}/api/v1/agents/${NODE}/check"
BODY="/tmp/a2a_check.$$.body"
ERR="/tmp/a2a_check.$$.err"
trap 'rm -f "$BODY" "$ERR"' EXIT INT TERM

if [ -n "$TOKEN" ]; then
  if ! CODE=$(curl -sS --max-time 15 -A "$UA" -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/json" -o "$BODY" -w "%{http_code}" -- "$URL" 2>"$ERR"); then
    echo "ERROR 请求失败"
    exit 2
  fi
else
  if ! CODE=$(curl -sS --max-time 15 -A "$UA" -H "Accept: application/json" -o "$BODY" -w "%{http_code}" -- "$URL" 2>"$ERR"); then
    echo "ERROR 请求失败"
    exit 2
  fi
fi

if [ "$CODE" != "200" ]; then
  if [ "$CODE" = "1010" ] || grep -q '1010' "$BODY" || { [ "$CODE" = "403" ] && ! grep -q '^{' "$BODY"; }; then
    echo "ERROR HTTP ${CODE} 非 JSON，疑似 Cloudflare 拦截，检查 User-Agent"
    exit 2
  fi
  if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
    echo "ERROR HTTP ${CODE} 未授权或禁止访问，检查 Token"
    exit 2
  fi
  echo "ERROR HTTP ${CODE}"
  exit 2
fi

if grep -q '"work"[[:space:]]*:[[:space:]]*true' "$BODY"; then
  echo "WORK"
  tr -d '\n' < "$BODY"
  echo
  exit 0
fi

if [ "$SILENT" -eq 1 ]; then
  exit 0
fi

echo "IDLE"
exit 0
