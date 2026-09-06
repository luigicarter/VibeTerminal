# Bundled hands-free models

All inference is local and CPU-only; these pretrained models need no user training or account.
`manifest.json` pins every runtime artifact by SHA256 and source URL. Run `npm run prepare:voice`
to verify the bundle or restore missing artifacts. Existing checksum failures are fatal.

* Keyword spotter: k2-fsa/sherpa-onnx English GigaSpeech 3.3M, 2024-01-01,
  int8 encoder/decoder/joiner, Apache-2.0 (see LICENSE-sherpa.txt).
  Original model card: https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
  The release archive is content-pinned; its URL alone is not immutable.
  `keywords.txt` was generated using SentencePiece and the archive's `bpe.model`
  from uppercase `HEY VIBE`; it is not a trained custom model.
* Speech detector: snakers4/silero-vad commit
  `867c2aa692646a1f1de3e94a15c9dd9f614c0acb`, MIT (LICENSE-silero.txt).
* Completion: pipecat-ai/smart-turn-v3, `smart-turn-v3.2-cpu.onnx`, Hugging Face
  revision `f766f81d3cfdf7737ac64aad813d91bbfd56bf93`, BSD-2-Clause
  (LICENSE-smart-turn.txt). Model card: https://huggingface.co/pipecat-ai/smart-turn-v3

The JavaScript Whisper frontend follows Hugging Face Transformers' Apache-2.0
numpy implementation and Pipecat's left-padded eight-second normalization contract.
Reference inference: https://github.com/pipecat-ai/smart-turn/blob/4786657e242dfe77dd138699ac564ee074a2a543/inference.py
No Python or training dependencies are shipped.
