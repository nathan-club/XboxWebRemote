FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    XWR_HOST=0.0.0.0 XWR_PORT=8977 XWR_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --create-home xwr \
    && mkdir /data && chown xwr:xwr /data
COPY server.py ./
COPY www/ ./www/
USER xwr
VOLUME ["/data"]
EXPOSE 8977
CMD ["python", "server.py"]
