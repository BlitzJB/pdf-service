FROM python:3.9-slim

WORKDIR /app

RUN pip install docker prometheus_client

COPY stats_exporter.py .

CMD ["python", "stats_exporter.py"] 