#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 SOURCE_DIR PATCH_FILE VCPKG_ROOT ARTIFACT_DIR" >&2
  exit 2
fi

issue55_source=$1
issue55_patch=$2
issue55_vcpkg=$3
issue55_artifacts=$4
issue55_sha=89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0
issue55_version=1.22.0-dev.20250409-89f8206ba4
issue55_patch_sha=4b368d00b9c4fc11cf5183caeed13d858e93b842cba26df27bde1b653d9372f2

test "$(sha256sum "$issue55_patch" | cut -d' ' -f1)" = "$issue55_patch_sha"
test "$(cmake --version | sed -n '1s/cmake version //p')" = 3.31.6
test "$(node --version)" = v20.19.4
[[ "$(python3.12 --version)" == Python\ 3.12.* ]]
test "$(git -C "$issue55_vcpkg" rev-parse HEAD)" = b02e341c927f16d991edbd915d8ea43eac52096c
issue55_node_bin=$(dirname "$(command -v node)")

if [[ ! -x "$issue55_vcpkg/vcpkg" ]]; then
  "$issue55_vcpkg/bootstrap-vcpkg.sh" -disableMetrics
fi
test -x "$issue55_vcpkg/vcpkg"

git clone --filter=blob:none https://github.com/microsoft/onnxruntime.git "$issue55_source"
git -C "$issue55_source" checkout --detach "$issue55_sha"
git -C "$issue55_source" submodule update --init --recursive
test "$(git -C "$issue55_source/cmake/external/emsdk" rev-parse HEAD)" = 074211759c17c646164d3271ca1d155cc174f78e
test "$(git -C "$issue55_source/cmake/external/onnx" rev-parse HEAD)" = b8baa8446686496da4cc8fda09f2b6fe65c2a02c
test "$(git -C "$issue55_source/cmake/external/libprotobuf-mutator" rev-parse HEAD)" = 7a2ed51a6b682a83e345ff49fc4cfd7ca47550db

git -C "$issue55_source" apply --check "$issue55_patch"
git -C "$issue55_source" apply "$issue55_patch"
git -C "$issue55_source" diff --check

if grep -REn 'const bool& terminate_flag|bool terminate = false' \
  "$issue55_source/include/onnxruntime/core/framework" \
  "$issue55_source/onnxruntime/core/framework"; then
  echo 'legacy non-atomic termination declaration remains' >&2
  exit 1
fi

pushd "$issue55_source/cmake/external/emsdk"
./emsdk install 4.0.4
./emsdk activate 4.0.4
source ./emsdk_env.sh
popd
# emsdk prepends its bundled Node. Re-prepend the independently pinned Node so
# package generation below actually uses the version asserted above.
export PATH="$issue55_node_bin:$PATH"
emcc --version | grep -Fq '4.0.4'
test "$(node --version)" = v20.19.4

export VCPKG_INSTALLATION_ROOT="$issue55_vcpkg"
issue55_common_args=(
  --parallel
  --use_vcpkg
  --config Release
  --skip_submodule_sync
  --build_wasm
  --enable_wasm_simd
  --enable_wasm_threads
  --target onnxruntime_webassembly
  --skip_tests
  --enable_wasm_api_exception_catching
  --disable_rtti
)

pushd "$issue55_source"
python3.12 ./tools/ci_build/build.py \
  "${issue55_common_args[@]}" \
  --build_dir "$issue55_source/build/wasm_inferencing"
python3.12 ./tools/ci_build/build.py \
  "${issue55_common_args[@]}" \
  --build_dir "$issue55_source/build/wasm_inferencing_jsep" \
  --use_jsep \
  --use_webnn

mkdir -p js/web/dist "$issue55_artifacts"
install -m 0644 \
  build/wasm_inferencing/Release/ort-wasm-simd-threaded.wasm \
  build/wasm_inferencing/Release/ort-wasm-simd-threaded.mjs \
  build/wasm_inferencing_jsep/Release/ort-wasm-simd-threaded.jsep.wasm \
  build/wasm_inferencing_jsep/Release/ort-wasm-simd-threaded.jsep.mjs \
  js/web/dist/

npm --prefix js ci
npm --prefix js/common ci
npm --prefix js/web ci
npm --prefix js/web run prebuild
npm --prefix js run lint
pushd js
npx prettier --check \
  .eslintrc.js \
  web/lib/index.ts \
  web/lib/wasm/run-cancellation.ts \
  web/lib/wasm/wasm-core-impl.ts \
  web/lib/wasm/wasm-types.ts \
  web/test/unittests/backends/wasm/test-run-cancellation.ts \
  web/test/unittests/index.ts \
  web/types.d.ts
popd

npm --prefix js/common version "$issue55_version" --allow-same-version --no-git-tag-version
npm --prefix js/web version "$issue55_version" --allow-same-version --no-git-tag-version
npm --prefix js run update-version -- common
npm --prefix js run update-version -- web
install -m 0644 LICENSE js/web/LICENSE
pushd js/web
npm pack --pack-destination "$issue55_artifacts"
popd

sha256sum \
  js/web/dist/ort-wasm-simd-threaded.wasm \
  js/web/dist/ort-wasm-simd-threaded.mjs \
  js/web/dist/ort-wasm-simd-threaded.jsep.wasm \
  js/web/dist/ort-wasm-simd-threaded.jsep.mjs \
  "$issue55_artifacts"/onnxruntime-web-"$issue55_version".tgz
popd
