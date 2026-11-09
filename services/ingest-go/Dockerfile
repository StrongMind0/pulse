# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Pure-Go SQLite driver: no cgo, fully static binary.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ingest ./cmd/ingest && mkdir -p /out/data

# Distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ingest /ingest
# A named volume copies this directory's ownership, so the non-root user can write to it.
COPY --from=build --chown=65532:65532 /out/data /data
ENV PULSE_DB_PATH=/data/ingest.db
VOLUME /data
EXPOSE 1883 8081
HEALTHCHECK --interval=5s --timeout=3s --retries=12 CMD ["/ingest", "healthcheck"]
ENTRYPOINT ["/ingest"]
