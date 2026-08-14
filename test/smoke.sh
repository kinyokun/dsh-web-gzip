#!/usr/bin/env bash
# dsh-web-gzip 冒烟测试：node:test 全量跑一遍，非零退出即失败。
set -euo pipefail
cd "$(dirname "$0")"
node --test gzip.test.mjs
