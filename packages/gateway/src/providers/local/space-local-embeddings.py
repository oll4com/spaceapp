"""Space Gateway's local embedding worker (Space Memory plan clipboard:o7SATwaOHqca): one ONNX text model on the CPU in its
own process, so inference never runs on the gateway's event loop and nothing leaves the server.

Arguments: model.onnx tokenizer.json max-tokens pooling(cls|mean) threads. scripts/space-local-embeddings-setup.mjs installs the
files at their pinned SHA-256 (hashing 0.5 GB again at every start would cost seconds). It prints {"ready": true} once loaded;
each stdin line {"id": n, "texts": [...]} gets one stdout line {"id": n, "vectors": [[...]], "tokens": n} (unit length) or
{"id": n, "error": "<exception type>"}. Texts are never logged.
"""
import json
import sys


def main(model, tokenizer_file, max_tokens, pooling, threads):
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    options = ort.SessionOptions()
    options.intra_op_num_threads = int(threads)
    options.inter_op_num_threads = 1
    # A shared host: no busy-waiting threads between requests, and no arena that keeps the largest batch's memory.
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.enable_cpu_mem_arena = False
    session = ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])
    inputs = {item.name for item in session.get_inputs()}
    tokenizer = Tokenizer.from_file(tokenizer_file)
    tokenizer.enable_truncation(int(max_tokens))
    tokenizer.enable_padding()
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            encodings = tokenizer.encode_batch(request["texts"])
            ids = np.array([encoding.ids for encoding in encodings], dtype=np.int64)
            mask = np.array([encoding.attention_mask for encoding in encodings], dtype=np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in inputs:
                feed["token_type_ids"] = np.zeros_like(ids)
            hidden = session.run(None, feed)[0]
            if hidden.ndim == 3:
                hidden = hidden[:, 0] if pooling == "cls" else (hidden * mask[..., None]).sum(1) / mask.sum(1, keepdims=True)
            vectors = hidden / np.linalg.norm(hidden, axis=1, keepdims=True)
            reply = {"id": request_id, "vectors": vectors.astype(np.float64).round(7).tolist(), "tokens": int(mask.sum())}
        except Exception as error:  # one bad request never stops the worker
            reply = {"id": request_id, "error": type(error).__name__}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main(*sys.argv[1:6])
