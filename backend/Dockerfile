# Build stage
# NOTE: run `go mod tidy` locally first so go.sum exists. Check that the
# golang image tag matches the `go` directive in go.mod.
FROM golang:1.27-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

# Runtime stage
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/server /app/server

# Tenant and feature config are mounted at /config; data lives in /pb_data.
ENV TENANT_CONFIG=/config/tenant.json
ENV FEATURES_CONFIG=/config/features.json
VOLUME /pb_data
EXPOSE 8090

ENTRYPOINT ["/app/server"]
CMD ["serve", "--http=0.0.0.0:8090", "--dir=/pb_data"]
