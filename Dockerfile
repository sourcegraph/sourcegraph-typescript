FROM node:11-alpine@sha256:49028b628012b5e35479d1f714ae3a6200eab9a8a7b8f3e95159183dbc14910a

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

WORKDIR /srv/server
EXPOSE 80 443 8080
CMD ["node", "--max_old_space_size=4096", "./dist/server.js"]
USER node
