# syntax=docker/dockerfile:1
FROM alpine:3.22 AS build
RUN apk add --no-cache build-base
WORKDIR /src
COPY . .
RUN make CC=gcc && make CC=gcc test

FROM alpine:3.22
RUN adduser -S -H sim
USER sim
COPY --from=build /src/build/pulse-sim /usr/local/bin/pulse-sim
ENTRYPOINT ["pulse-sim"]
CMD ["--host", "ingest", "--devices", "9", "--chaos"]
