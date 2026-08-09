#!/usr/bin/env bash
set -euo pipefail

ort_tree=${1:-/tmp/onnxruntime-issue55-mailbox}
expected_sha=89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0

cd "$ort_tree"
test "$(git rev-parse HEAD)" = "$expected_sha"
git diff --check

if rg -n 'const bool& terminate_flag|bool terminate = false' \
  include/onnxruntime/core/framework \
  onnxruntime/core/framework; then
  echo 'legacy non-atomic termination declaration remains' >&2
  exit 1
fi

for symbol in \
  OrtGetRunCancellationMailbox \
  OrtBeginRunCancellation \
  OrtIsRunCancellationRequested \
  OrtEndRunCancellation; do
  rg -q "EMSCRIPTEN_KEEPALIVE $symbol" onnxruntime/wasm/api.h
  rg -q "^.*$symbol\\(" onnxruntime/wasm/api.cc
  rg -q "_$symbol" js/web/lib/wasm/wasm-types.ts
  rg -q "'_$symbol'" js/.eslintrc.js
done

# The request-state query remains an exported diagnostic ABI, but production
# cancellation classification relies on End's native winning-status
# acknowledgement rather than treating a late request as cancellation.
for runtime_symbol in \
  OrtGetRunCancellationMailbox \
  OrtBeginRunCancellation \
  OrtEndRunCancellation; do
  rg -q "_$runtime_symbol" js/web/lib/wasm/run-cancellation.ts
done
if rg -q '_OrtIsRunCancellationRequested' js/web/lib/wasm/run-cancellation.ts; then
  echo 'production bridge must not classify cancellation from the request cell' >&2
  exit 1
fi

for public_api in \
  requestWasmRunCancellation \
  setWasmRunCancellationObserver \
  WasmRunCancellationError; do
  rg -q "$public_api" js/web/lib/index.ts
  rg -q "$public_api" js/web/types.d.ts
done

for conversion in \
  'OrtGetRunCancellationMailbox:p' \
  'OrtBeginRunCancellation:_p' \
  'OrtEndRunCancellation:_p_'; do
  rg -Fq "$conversion" cmake/onnxruntime_webassembly.cmake
done

rg -q 'std::atomic<bool> locally_requested_' include/onnxruntime/core/framework/run_options.h
rg -q 'std::atomic<uint32_t> cancellation_generation' onnxruntime/wasm/api.cc
rg -q 'std::atomic<uint32_t> active_generation' onnxruntime/wasm/api.cc
rg -q 'std::atomic<uint32_t> observed_generation' onnxruntime/wasm/api.cc
rg -q 'AcknowledgeExternalCancellation' \
  include/onnxruntime/core/framework/run_options.h \
  onnxruntime/core/framework/stream_execution_context.cc
rg -q 'const bool cancellation_observed' onnxruntime/wasm/api.cc
rg -q 'instanceof SharedArrayBuffer' js/web/lib/wasm/run-cancellation.ts
rg -q 'ERR_ORT_WASM_RUN_CANCELED' js/web/lib/wasm/run-cancellation.ts js/web/types.d.ts
rg -q 'beginWasmRunCancellation' js/web/lib/wasm/wasm-core-impl.ts
rg -q 'endWasmRunCancellation' js/web/lib/wasm/wasm-core-impl.ts
rg -q 'distinct run-options handle for each call' js/web/lib/wasm/run-cancellation.ts
rg -q 'test-run-cancellation' js/web/test/unittests/index.ts
rg -q '\$\{TEST_SRC_DIR\}/framework/\*\.cc' cmake/onnxruntime_unittests.cmake

terminate_reference_count=$(rg -l 'terminate_flag|\.terminate\b' \
  include/onnxruntime/core/framework \
  onnxruntime/core \
  onnxruntime/test | wc -l)
test "$terminate_reference_count" -gt 0

echo "static audit passed for $expected_sha ($terminate_reference_count files with termination references)"
