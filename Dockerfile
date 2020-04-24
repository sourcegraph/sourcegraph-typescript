FROM node:13.13.0-alpine@sha256:80e4f9b287449c07083854eb11a8bd18209e4c228848295705ae7adfa00a39c9

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

WORKDIR /srv/dist
EXPOSE 80 443 8080
CMD ["node", "--max_old_space_size=4096", "./server.js"]
USER node
