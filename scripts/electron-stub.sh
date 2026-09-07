#!/bin/sh
exec /usr/bin/env node "$(dirname "$0")/electron-stub.mjs" "$@"
