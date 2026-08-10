#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_DIR ARTIFACT_DIR" >&2
  exit 2
fi

issue55_source=$1
issue55_artifacts=$2
issue55_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
issue55_sha=89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0
issue55_version=1.22.0-dev.20250409-89f8206ba4
issue55_license_sha=2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c
issue55_notices_sha=e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc
issue55_modification_notice_sha=9c451ee63c6c8a7c95c6def90acb21f866a582a3c31814e244b036d2eeac9d85
issue55_vcpkg_config_sha=11d905868d78604f6c4ed97718b7e229c8cc5e5ea78d566ce53e2748c5fe6f1f

test "$(git -C "$issue55_source" rev-parse HEAD)" = "$issue55_sha"
test "$(node --version)" = v20.19.4
test "$(sha256sum "$issue55_source/LICENSE" | cut -d' ' -f1)" = "$issue55_license_sha"
test "$(sha256sum "$issue55_source/ThirdPartyNotices.txt" | cut -d' ' -f1)" = "$issue55_notices_sha"
test "$(sha256sum "$issue55_script_dir/LINELIGHT-NOTICE.txt" | cut -d' ' -f1)" = "$issue55_modification_notice_sha"
test "$(sha256sum "$issue55_source/cmake/vcpkg-configuration.json" | cut -d' ' -f1)" = "$issue55_vcpkg_config_sha"
grep -Fq '"baseline": "a29711cc86340a43c054cd37b8bd2871332a01e9"' \
  "$issue55_source/cmake/vcpkg-configuration.json"
test "$(node -p "require('$issue55_source/js/web/package.json').version")" = "$issue55_version"
"$issue55_script_dir/static-audit.sh" "$issue55_source"

install -m 0644 \
  "$issue55_source/ThirdPartyNotices.txt" \
  "$issue55_source/js/web/ThirdPartyNotices.txt"
install -m 0644 \
  "$issue55_script_dir/LINELIGHT-NOTICE.txt" \
  "$issue55_source/js/web/LINELIGHT-NOTICE.txt"
rm -f "$issue55_artifacts/onnxruntime-web-$issue55_version.tgz"
pushd "$issue55_source/js/web"
npm pack --pack-destination "$issue55_artifacts"
popd

issue55_tar_listing=$(tar -tzf "$issue55_artifacts/onnxruntime-web-$issue55_version.tgz")
grep -Fxq package/LICENSE <<<"$issue55_tar_listing"
grep -Fxq package/LINELIGHT-NOTICE.txt <<<"$issue55_tar_listing"
grep -Fxq package/ThirdPartyNotices.txt <<<"$issue55_tar_listing"
test "$(tar -xOf "$issue55_artifacts/onnxruntime-web-$issue55_version.tgz" package/LICENSE | sha256sum | cut -d' ' -f1)" = "$issue55_license_sha"
test "$(tar -xOf "$issue55_artifacts/onnxruntime-web-$issue55_version.tgz" package/LINELIGHT-NOTICE.txt | sha256sum | cut -d' ' -f1)" = "$issue55_modification_notice_sha"
test "$(tar -xOf "$issue55_artifacts/onnxruntime-web-$issue55_version.tgz" package/ThirdPartyNotices.txt | sha256sum | cut -d' ' -f1)" = "$issue55_notices_sha"
sha256sum \
  "$issue55_source/js/web/dist/ort-wasm-simd-threaded.wasm" \
  "$issue55_source/js/web/dist/ort-wasm-simd-threaded.mjs" \
  "$issue55_source/js/web/dist/ort-wasm-simd-threaded.jsep.wasm" \
  "$issue55_source/js/web/dist/ort-wasm-simd-threaded.jsep.mjs" \
  "$issue55_artifacts/onnxruntime-web-$issue55_version.tgz"
