FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /build
ARG JDBC_VERSION=42.7.13
ARG JDBC_SHA256=6e0e4cc2d8cae902084f8a2b18728b073a6fd9d1f87c9d8bff8f298c18185b93
RUN curl --fail --location --retry 3 "https://jdbc.postgresql.org/download/postgresql-${JDBC_VERSION}.jar" --output postgresql.jar \
    && echo "${JDBC_SHA256}  postgresql.jar" | sha256sum --check
COPY src ./src
COPY healthcheck.java ./healthcheck.java
RUN javac --release 21 -d classes src/opentrace/*.java healthcheck.java

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
COPY --from=build /build/classes ./classes
COPY --from=build /build/postgresql.jar ./lib/postgresql.jar
USER 10001:10001
ENV API_PORT=8080 API_HOST=0.0.0.0
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD java -cp /app/classes Healthcheck
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70.0", "-cp", "/app/classes:/app/lib/postgresql.jar", "opentrace.Main"]
