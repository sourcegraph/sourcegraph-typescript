# Sourcegraph code intelligence for TypeScript

A Sourcegraph extension that provides code intelligence for TypeScript.

## How to deploy the server

The extension is configured to talk to a language server deployed somewhere over WebSockets.
The server is available as a Docker image `sourcegraph/lang-typescript` from Docker Hub.

You can run it locally with:

```sh
docker run sourcegraph/lang-typescript -p 80:8080
```

This will make the server listen on `ws://localhost:8080`, which is the address you then need to specify in Sourcegraph settings for the extension to connect to.

### Using Kubernetes

If you want to deploy the language server with Kubernetes, your deployment should look like this:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lang-typescript
spec:
  selector:
    matchLabels:
      app: lang-typescript
  template:
    replicas: 4 # adjust as needed
    metadata:
      labels:
        app: lang-typescript
    spec:
      containers:
        - name: lang-typescript
          image: sourcegraph/lang-typescript
          ports:
            - containerPort: 433
              name: wss
          env:
            - name: PORT
              value: 433
            # TLS certificate and key to secure the WebSocket connection (optional)
            - name: TLS_CERT
              value: ... your TLS certificate ...
            - name: TLS_KEY
              value: ... your TLS key ...
          # Resources to provision for the server (adjust as needed)
          resources:
            limits:
              cpu: '4'
              memory: 5Gi
            requests:
              cpu: 500m
              memory: 2Gi
          # Probes the server periodically to see if it is healthy
          livenessProbe:
            initialDelaySeconds: 30
            tcpSocket:
              port: wss
            timeoutSeconds: 5
          readinessProbe:
            tcpSocket:
              port: wss
```

With a corresponding service:

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: lang-typescript
    deploy: lang-typescript
  name: lang-typescript
spec:
  ports:
    - name: wss
      port: 433
  selector:
    app: lang-typescript
  type: LoadBalancer
```

#### TLS

TLS is optional but recommended for production deployments. It is used if `TLS_KEY` and `TLS_CERT` environment variables are set.

#### Enabling OpenTracing

The server can report spans through OpenTracing to diagnose issues.
If the environment variables `LIGHTSTEP_PROJECT` and `LIGHTSTEP_ACCESS_TOKEN` are set, the server will send tracing data to the given LightStep instance.
Support for other OpenTracing implementations can easily added here.

```diff
  env:
+   - name: LIGHTSTEP_PROJECT
+     value: my_project
+   - name: LIGHTSTEP_ACCESS_TOKEN
+     value: abcdefg
```

#### Improving performance with an SSD

To improve performance of dependency installation, the server can be configured to use a mounted SSD at a given directory by setting the `CACHE_DIR` environment variable. The instructions for how to mount a SSD depend on your deployment environment.

1. Add a volume for the mount path of the SSD:
    ```diff
      spec:
    + volumes:
    +   - hostPath:
    +       path: /path/to/mounted/ssd
    +     name: cache-ssd
    ```
    For example, Google Cloud Platform mounts the first SSD disk to `/mnt/disks/ssd0`.

2. Add a volume mount to the container spec:

    ```diff
      image: sourcegraph/lang-typescript
    + volumeMounts:
    +   - mountPath: /mnt/cache
    +     name: cache-ssd
    ```

3. Tell the language server to use the mount as the root for temporary directories:

    ```diff
      env:
    +   - name: CACHE_DIR
    +     value: /mnt/cache
    ```

#### Improving performance with an npm registry proxy

To further speed up dependency installation, all npm registry requests can be proxied through a cache running on the same node.

Example deployment for Kubernetes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: npm-proxy
spec:
  minReadySeconds: 10
  replicas: 1
  revisionHistoryLimit: 10
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: npm-proxy
    spec:
      containers:
        - image: sourcegraph/npm-proxy:latest
          name: npm-proxy
          ports:
            - containerPort: 8080
              name: http
          resources:
            limits:
              cpu: '1'
              memory: 1Gi
          volumeMounts:
            - mountPath: /cache
              name: npm-proxy-cache
      volumes:
        - name: npm-proxy-cache
          persistentVolumeClaim:
            claimName: npm-proxy
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  annotations:
    volume.beta.kubernetes.io/storage-class: default
  name: npm-proxy
  namespace: prod
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  labels:
    app: npm-proxy
  name: npm-proxy
spec:
  ports:
    - name: http
      port: 8080
      targetPort: http
  selector:
    app: npm-proxy
  type: ClusterIP
```

Then define a `.yarnrc` as a config map that points to the proxy:

```yaml
apiVersion: v1
data:
  .yarnrc: |
    # THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
    # yarn lockfile v1


    https-proxy "http://npm-proxy:8080"
    proxy "http://npm-proxy:8080"
    strict-ssl false
kind: ConfigMap
metadata:
  name: yarn-config
  namespace: prod
```

and mount it into the container:

```diff
+ volumeMounts:
+  - mountPath: /yarn-config
+    name: yarn-config
```

```diff
+ volumes:
+   - configMap:
+       name: yarn-config
+     name: yarn-config
```

#### Support for dependencies on private packages and git repositories

Dependencies on private npm packages is currently supported by mounting an `.npmrc` into the container that contains the registry token.
For dependencies on private git repositories, mount an SSH key into `~/.ssh`.

## Contributing

You need NodeJS >=10 and yarn installed.

```
# Install dependencies
yarn
# Build the extension and the server
yarn run build
```

To debug the server, build, then run it locally with `yarn start-server` and point the extension to it through Sourcegraph settings:

```json
"typescript.serverUrl": "ws://localhost:8080"
```

To also debug the extension, serve the extension from localhost with `yarn serve-ext` and configure Sourcegraph to fetch the bundle from localhost:

```json
// TODO
```
