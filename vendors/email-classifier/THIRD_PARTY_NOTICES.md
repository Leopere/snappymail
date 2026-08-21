# Local email classifier third-party notices

The classifier is bundled and served from the same origin. It never downloads runtime or model files in the browser.

## Bundled artifact and license mapping

| Bundled path | Redistributed component | Pinned version or revision | License text |
| --- | --- | --- | --- |
| `runtime/transformers.min.js` | `@xenova/transformers` | 2.17.2 | [Apache License 2.0](licenses/Apache-2.0.txt) |
| `runtime/transformers.min.js` | ONNX Runtime Web/Common (embedded) | 1.14.0 | [MIT License — Microsoft](licenses/MIT-ONNX-Runtime.txt) |
| `runtime/transformers.min.js` | `@huggingface/jinja` (embedded) | 0.2.2 | [MIT License — Hugging Face](licenses/MIT-Hugging-Face-Jinja.txt) |
| `runtime/ort-wasm-simd.wasm` | ONNX Runtime Web | 1.14.0 | [MIT License — Microsoft](licenses/MIT-ONNX-Runtime.txt) |
| `models/minilm-l3/config.json` | `Xenova/paraphrase-MiniLM-L3-v2` | `4b544e74dfc3256b2b56849ea5d7064fee1ac846` | [Apache License 2.0](licenses/Apache-2.0.txt) |
| `models/minilm-l3/tokenizer.json` | `Xenova/paraphrase-MiniLM-L3-v2` | `4b544e74dfc3256b2b56849ea5d7064fee1ac846` | [Apache License 2.0](licenses/Apache-2.0.txt) |
| `models/minilm-l3/tokenizer_config.json` | `Xenova/paraphrase-MiniLM-L3-v2` | `4b544e74dfc3256b2b56849ea5d7064fee1ac846` | [Apache License 2.0](licenses/Apache-2.0.txt) |
| `models/minilm-l3/onnx/model_quantized.onnx` | `Xenova/paraphrase-MiniLM-L3-v2` | `4b544e74dfc3256b2b56849ea5d7064fee1ac846` | [Apache License 2.0](licenses/Apache-2.0.txt) |

The converted model revision identifies `sentence-transformers/paraphrase-MiniLM-L3-v2` as its base model. The base model is published under Apache-2.0, and the conversion repository declares no different license. The Apache-2.0 text above therefore accompanies the converted weights, tokenizer, and configuration files.

## Authoritative upstream sources

- `@xenova/transformers` 2.17.2 package and license: https://www.npmjs.com/package/@xenova/transformers/v/2.17.2 and https://github.com/xenova/transformers.js/blob/2.17.2/LICENSE
- ONNX Runtime 1.14.0 source and license: https://github.com/microsoft/onnxruntime/tree/v1.14.0 and https://github.com/microsoft/onnxruntime/blob/v1.14.0/LICENSE
- `@huggingface/jinja` 0.2.2 package and license: https://www.npmjs.com/package/@huggingface/jinja/v/0.2.2 and https://github.com/huggingface/huggingface.js/blob/ec839abe9119a1247ffb8e7dcc63302915e09258/LICENSE
- Converted model revision: https://huggingface.co/Xenova/paraphrase-MiniLM-L3-v2/tree/4b544e74dfc3256b2b56849ea5d7064fee1ac846
- Apache-2.0 base model: https://huggingface.co/sentence-transformers/paraphrase-MiniLM-L3-v2

The bundled model is a non-generative 384-dimensional sentence encoder. SnappyMail applies a fixed, local category prototype layer; no message content is sent to any model provider.
