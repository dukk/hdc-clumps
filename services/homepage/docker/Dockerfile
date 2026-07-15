# Extends upstream gethomepage with iputils ping (busybox ping fails in Docker-on-LXC).
ARG HOMEPAGE_BASE_TAG=latest
FROM ghcr.io/gethomepage/homepage:${HOMEPAGE_BASE_TAG}
USER root
RUN apk add --no-cache iputils
USER node
