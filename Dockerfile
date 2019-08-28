FROM node:11.15.0-alpine@sha256:914ff2c2145de019a19c080a9e42b5763c826194110ec8e02c8e92845799fba6

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
