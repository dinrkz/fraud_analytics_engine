FROM gcc:14-bookworm AS generator
WORKDIR /src
COPY data_generator/src/main.cpp ./main.cpp
RUN g++ -std=c++17 -O3 -Wall -Wextra -pthread -static-libstdc++ -static-libgcc main.cpp -o /transaction_generator

FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 GENERATOR_PATH=/usr/local/bin/transaction_generator
WORKDIR /app
COPY analytics_engine/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home app
COPY --from=generator /transaction_generator /usr/local/bin/transaction_generator
COPY analytics_engine/app ./app
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3)"
CMD ["python","-m","uvicorn","app.main:app","--host","0.0.0.0","--port","8000"]
