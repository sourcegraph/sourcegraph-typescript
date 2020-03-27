FROM node:13.11.0-alpine@sha256:5769ed0cbef82ecd0d3b9522a086da41927d09ed38a286ab3c76b36bfc5f4e7a

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
