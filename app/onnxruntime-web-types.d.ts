// The pinned package exports its runtime but omits a TypeScript `types`
// condition. Reference its own reviewed declarations instead of duplicating
// the cancellation bridge contract in application source.
import "../node_modules/onnxruntime-web/types.d.ts";
