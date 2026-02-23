FROM golang:1.24-alpine AS certspotter-build
RUN go install software.sslmate.com/src/certspotter/cmd/certspotter@latest

FROM node:20-alpine

RUN apk add --no-cache bash

COPY --from=certspotter-build /go/bin/certspotter /usr/local/bin/certspotter

RUN mkdir -p /var/lib/certspotter /app

# Empty watchlist file - certspotter requirement
RUN touch /var/lib/certspotter/watchlist

COPY sidecar.js /app/sidecar.js
COPY entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

ENV CERTSPOTTER_STATE_DIR=/var/lib/certspotter
ENV BACKEND_URL=""
ENV MONITOR_ID="monitor-default"
ENV POLL_INTERVAL_MS="30000"

ENTRYPOINT ["/app/entrypoint.sh"]
