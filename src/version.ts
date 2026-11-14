import pkg from "../package.json" with { type: "json" };

/** The server's version, sent as `X-Hydra-Server-Version` and in /healthz. */
export const SERVER_VERSION: string = pkg.version;
