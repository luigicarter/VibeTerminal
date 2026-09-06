"""Development only: reproduce NumPy Whisper parity fixtures; never shipped runtime."""
import gzip,json,pathlib,hashlib
import numpy as np
import transformers
from transformers import WhisperFeatureExtractor
root=pathlib.Path(__file__).parent
extractor=WhisperFeatureExtractor(chunk_length=8)
cases=[]
# Deterministic broad-spectrum integer sequence also catches window boundary errors.
for count in [6400,144000,128000]:
 i=np.arange(count,dtype=np.int64)
 audio=(((i*7919+i*i*13)%65521)-32760).astype(np.float32)/np.float32(65536)
 audio[:min(333,count)]=0
 if count==128000: audio[:]=np.float32(0.1)
 window=np.pad(audio,(max(0,128000-count),0))[-128000:]
 normalized=extractor.zero_mean_unit_var_norm([window],attention_mask=[np.ones(128000,dtype=np.int32)])[0]
 features=extractor._np_extract_fbank_features(normalized[None,:],device='cpu').astype(np.float32)
 # Preserve all features compressed to detect errors in every frequency/time bin.
 name=f'voice-whisper-{count}.f32.gz'
 with gzip.GzipFile(filename=str(root/name),mode='wb',mtime=0) as f:f.write(features.tobytes())
 cases.append(dict(samples=count,file=name,sha256=hashlib.sha256(features.tobytes()).hexdigest()))
(root/'voice-whisper-reference.json').write_text(json.dumps(dict(transformers=transformers.__version__,numpy=np.__version__,reference='WhisperFeatureExtractor._np_extract_fbank_features; normalized left-padded 8sec; Pipecat inference contract',cases=cases),indent=2)+'\n')
