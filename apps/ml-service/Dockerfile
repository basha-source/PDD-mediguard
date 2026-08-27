# MediGuard ML service -- targets a Hugging Face Space (Docker SDK, free CPU).
#
# Python 3.11: paddlepaddle 3.1 does publish wheels up to 3.13, so this is no
# longer a hard constraint, but 3.11 is the version Paddle is best tested
# against and the image is known to build on it. Local dev runs 3.13.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # HF Spaces runs as a non-root user; give the caches a writable home.
    HF_HOME=/home/user/.cache/huggingface \
    TRANSFORMERS_CACHE=/home/user/.cache/huggingface \
    MPLCONFIGDIR=/tmp/matplotlib

# libgl/libglib are required by opencv, which paddleocr pulls in.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
USER user
ENV PATH=/home/user/.local/bin:$PATH
WORKDIR /home/user/app

COPY --chown=user requirements*.txt ./
# CPU-only torch: the default index would pull ~2GB of unusable CUDA libraries.
RUN pip install --user --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt

COPY --chown=user app ./app
COPY --chown=user scripts ./scripts
COPY --chown=user data ./data

# Bake the model weights and the derived indexes into the image so a cold start
# is container spin-up only, not a download plus an 8s index rebuild.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')" \
 && python -c "from app.ocr.matcher import NameMatcher; NameMatcher.build().save()"

EXPOSE 7860
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
