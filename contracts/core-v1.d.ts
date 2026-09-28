export declare const CORE_SERVICE: "netnavr-core";
export declare const CORE_API_VERSION: "v1";
export declare const CORE_SCHEMA_VERSION: 1;

export interface CoreNodeIdentity {
  nodeId: string;
  createdAt: string;
  schemaVersion: typeof CORE_SCHEMA_VERSION;
}

export interface CoreHealth {
  service: typeof CORE_SERVICE;
  status: "ok";
  apiVersion: typeof CORE_API_VERSION;
  version: string;
  uptimeSeconds: number;
}

export type CoreErrorCode =
  | "invalid_request_target"
  | "method_not_allowed"
  | "not_found"
  | "request_body_not_allowed";

export interface CoreErrorEnvelope {
  error: { code: CoreErrorCode; message: string };
  requestId: string;
}
