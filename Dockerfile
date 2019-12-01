FROM node:13.2.0-alpine@sha256:4f413a16316edba7dd29f1d50b93f440706c538865308f31d4ce2d7d29c7bda5

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
