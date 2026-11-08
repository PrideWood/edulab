#!/bin/zsh
cd "$(dirname "$0")"
if command -v node >/dev/null; then
  exec node start_with_edulab.mjs "$@"
else
  echo "请先安装Node.js，才能连接EduLab共享模型和云端备份。"
  read
fi
