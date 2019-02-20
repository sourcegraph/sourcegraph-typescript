FROM node:11-alpine@sha256:40ec325349d19763a209144e42b5bd53953a63cb4a761909ff43a5ca57d7d61f

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
