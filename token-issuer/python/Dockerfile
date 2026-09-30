FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=8083 KEYS_DIR=/app/keys
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY fray_token_issuer ./fray_token_issuer
COPY app.py ./
RUN useradd --create-home --uid 10001 issuer && mkdir /app/keys && chown issuer:issuer /app/keys
USER issuer
VOLUME /app/keys
EXPOSE 8083
# Local example only: explicit mock opt-in required; replace validate_user for production.
CMD ["python", "app.py"]
