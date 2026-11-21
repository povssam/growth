# Growth GPU worker — RunPod Serverless (scale-to-zero, pay per second).
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 HF_HOME=/models HF_HUB_DISABLE_TELEMETRY=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake model weights into the image so cold starts never download them.
RUN python -c "from transformers import AutoImageProcessor, UperNetForSemanticSegmentation as M; \
m='openmmlab/upernet-convnext-large'; AutoImageProcessor.from_pretrained(m); M.from_pretrained(m)"

COPY growth_engine ./growth_engine
COPY handler.py .
ENV HF_HUB_OFFLINE=1
CMD ["python", "-u", "handler.py"]
