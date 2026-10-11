#!/bin/sh
# Banc du moteur natif POUR LE TÉLÉPHONE (arm64-v8a) : llama.cpp sur le processeur, compilé
# avec les MÊMES options que l'APK (android/app/src/main/cpp/CMakeLists.txt :
# armv8.2-a+dotprod+fp16, sans OpenMP, réempaquetage Q4_0 actif) — sans Vulkan, que le banc
# processeur n'utilise pas. Produit dans $OUT :
#   vh_llm_bench  le code de l'application (vh_llm.cpp) : essai à vide et questions, run.mjs
#   llama-bench   l'outil de mesure de llama.cpp (fils, quantification, contexte)
#
#   LLAMA_DIR=…/llama.cpp ANDROID_NDK=…/ndk/28.2.13676358 scripts/bench-native/android.sh
# puis scripts/bench-native/phone.sh (téléphone branché, débogage USB actif).
set -e
here=$(cd "$(dirname "$0")" && pwd)
: "${LLAMA_DIR:=$HOME/.cache/vh-tools/src/llama.cpp}"
: "${ANDROID_NDK:=$HOME/.cache/vh-tools/sdk/ndk/28.2.13676358}"
: "${OUT:=$here/android-arm64}"
: "${CMAKE:=$(command -v cmake || echo "$HOME/.cache/vh-tools/sdk/cmake/3.31.6/bin/cmake")}"
build="$LLAMA_DIR/build-android-arm64"
"$CMAKE" -S "$LLAMA_DIR" -B "$build" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$(dirname "$CMAKE")/ninja" \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DANDROID_STL=c++_static \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF -DGGML_LLAMAFILE=OFF -DGGML_VULKAN=OFF \
  -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16 \
  -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TOOLS=ON >/dev/null
"$CMAKE" --build "$build" --target llama llama-bench -j"$(nproc)" >/dev/null
mkdir -p "$OUT"
cp "$build/bin/llama-bench" "$OUT/"
cxx="$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android28-clang++"
"$cxx" -std=c++17 -O2 -march=armv8.2-a+dotprod+fp16 -static-libstdc++ \
  -I"$here/../../android/app/src/main/cpp" -I"$LLAMA_DIR/include" -I"$LLAMA_DIR/ggml/include" \
  "$here/../../android/app/src/main/cpp/vh_llm.cpp" "$here/bench.cpp" \
  -L"$build/src" -L"$build/ggml/src" -lllama -lggml -lggml-cpu -lggml-base -llog -o "$OUT/vh_llm_bench"
"$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" "$OUT/llama-bench" "$OUT/vh_llm_bench"
ls -la "$OUT"
