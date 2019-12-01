FROM node:13.1.0-alpine@sha256:6b20f3cb99f7bd87be6b4987e73ebf018fde14d49e15102c44f71c3c47d417ee

# Use tini (https://github.com/krallin/tini) for proper signal handling.
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

# Allow to mount a custom yarn config
RUN mkdir /yarn-config \
    && touch /yarn-config/.yarnrc \
    && ln -s /yarn-config/.yarnrc /usr/local/share/.yarnrc

# Add git, needed for yarn
RUN apk add --no-cache bash git openssh

COPY ./ /srv

WORKDIR /srv/lib/server
EXPOSE 80 443 8080
CMD ["node", "--max_old_space_size=4096", "./server.js"]
USER node
