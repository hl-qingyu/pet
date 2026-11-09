#!/bin/bash
set -e
PET_ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$PET_ROOT"
if [ ! -x node_modules/.bin/electron ]; then
  echo 'Please run npm install in this folder first.'
  exit 1
fi
unset ELECTRON_RUN_AS_NODE
exec node_modules/.bin/electron "$PET_ROOT" "--config=$PET_ROOT/config.json"
