FROM python:3.11-slim

RUN apt-get update && apt-get install -y tor chromium chromium-driver && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir PySocks requests beautifulsoup4 selenium undetected-chromedriver

COPY scraper.py /app/scraper.py
WORKDIR /app

CMD bash -c "tor & sleep 60 && python -u scraper.py"