"""Screenshot-only OCR: in-memory JSON lines; no phone or account access."""
import base64
import io
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / '.phone-python-deps'))
from PIL import Image
import numpy as np
from rapidocr_onnxruntime import RapidOCR
Image.MAX_IMAGE_PIXELS = 32000000
engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=2)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        data = request.get('data', '')
        if not isinstance(data, str) or len(data) > 24 * 1024 * 1024:
            raise ValueError('image size')
        image = Image.open(io.BytesIO(base64.b64decode(data, validate=True))).convert('RGB')
        if image.width * image.height > 32000000:
            raise ValueError('image size')
        results, _ = engine(np.asarray(image)[:, :, ::-1].copy())
        nodes = []
        for box, text, confidence in results or []:
            if confidence < .65 or not str(text).strip():
                continue
            left, right = max(0, int(min(p[0] for p in box))), min(image.width, int(max(p[0] for p in box)))
            top, bottom = max(0, int(min(p[1] for p in box))), min(image.height, int(max(p[1] for p in box)))
            if left < right and top < bottom:
                nodes.append({'text': str(text)[:200], 'source': 'ocr', 'confidence': round(float(confidence), 3),
                              'bounds': {'left': left, 'top': top, 'right': right, 'bottom': bottom}})
        print(json.dumps({'id': request['id'], 'nodes': nodes[:100]}, ensure_ascii=True), flush=True)
    except Exception:
        print(json.dumps({'id': request.get('id'), 'nodes': [], 'error': 'ocr_failed'}), flush=True)
