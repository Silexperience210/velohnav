#!/bin/sh
# Compile le banc du moteur natif contre une construction de llama.cpp pour PC.
#   LLAMA_DIR=…/llama.cpp LLAMA_BUILD=…/build-host scripts/bench-native/build.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
: "${LLAMA_DIR:=$HOME/.cache/vh-tools/src/llama.cpp}"
: "${LLAMA_BUILD:=$LLAMA_DIR/build-host}"
c++ -std=c++17 -O2 -I"$here/../../android/app/src/main/cpp" -I"$LLAMA_DIR/include" -I"$LLAMA_DIR/ggml/include" \
  "$here/../../android/app/src/main/cpp/vh_llm.cpp" "$here/bench.cpp" \
  -L"$LLAMA_BUILD/bin" -lllama -lggml -lggml-base -Wl,-rpath,"$LLAMA_BUILD/bin" -o "$here/vh_llm_bench"
echo "$here/vh_llm_bench"
