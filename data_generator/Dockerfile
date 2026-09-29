FROM gcc:14-bookworm AS builder
WORKDIR /build
COPY src/main.cpp .
RUN g++ -std=c++17 -O2 -Wall -Wextra -Wpedantic -pthread -static-libstdc++ -static-libgcc main.cpp -o transaction_generator

FROM debian:bookworm-slim
RUN groupadd --gid 10001 opentrace && useradd --uid 10001 --gid opentrace --no-create-home opentrace
COPY --from=builder /build/transaction_generator /usr/local/bin/transaction_generator
USER opentrace
ENTRYPOINT ["transaction_generator"]
CMD ["--rate", "20"]
