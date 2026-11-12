#!/bin/sh
lsof -ti:3210 -ti:3000 | xargs kill -9 2>/dev/null
pnpm dev
