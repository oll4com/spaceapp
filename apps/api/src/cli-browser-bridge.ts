import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { idSchema } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";

export const cliBrowserBridgeTokenHeader = "x-space-cli-browser-token";

const tokenPrefix = "clibrowser.v1";
const defaultTokenTtlMs = 12 * 60 * 60 * 1000;

const cliBrowserBridgeTokenPayloadSchema = z.object({
  roomId: idSchema,
  paneId: idSchema,
  cliSessionId: idSchema,
  iat: z.number().int().min(0),
  exp: z.number().int().min(0)
});

export type CliBrowserBridgeTokenPayload = z.infer<typeof cliBrowserBridgeTokenPayloadSchema>;

export interface CliBrowserBridgeContext {
  roomId?: string | null;
  paneId?: string | null;
  cliSessionId?: string | null;
}

function signingSecret(config: Pick<SpaceApiConfig, "internalApiToken">): string | null {
  return config.internalApiToken ? `cli-browser:${config.internalApiToken}` : null;
}

function signPayload(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function cliBrowserBridgeEnabled(config: Pick<SpaceApiConfig, "browserToolBridgeEnabled" | "internalApiToken">): boolean {
  return Boolean(config.browserToolBridgeEnabled && config.internalApiToken);
}

export function issueCliBrowserBridgeToken(
  config: Pick<SpaceApiConfig, "browserToolBridgeEnabled" | "internalApiToken">,
  context: CliBrowserBridgeContext,
  nowMs = Date.now()
): string | null {
  const secret = signingSecret(config);
  if (!cliBrowserBridgeEnabled(config) || !secret || !context.roomId || !context.paneId || !context.cliSessionId) {
    return null;
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = cliBrowserBridgeTokenPayloadSchema.parse({
    roomId: context.roomId,
    paneId: context.paneId,
    cliSessionId: context.cliSessionId,
    iat: issuedAt,
    exp: Math.floor((nowMs + defaultTokenTtlMs) / 1000)
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${tokenPrefix}.${encodedPayload}.${signPayload(secret, encodedPayload)}`;
}

export function verifyCliBrowserBridgeToken(
  config: Pick<SpaceApiConfig, "internalApiToken">,
  token: string | null | undefined,
  nowMs = Date.now()
): CliBrowserBridgeTokenPayload | null {
  const secret = signingSecret(config);
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [prefix, version, encodedPayload, signature] = parts;
  if (`${prefix}.${version}` !== tokenPrefix || !encodedPayload || !signature) return null;
  const expected = signPayload(secret, encodedPayload);
  if (!secureEqual(expected, signature)) return null;
  try {
    const payload = cliBrowserBridgeTokenPayloadSchema.parse(JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")));
    if (payload.exp <= Math.floor(nowMs / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function cliBrowserBridgeApiBaseUrl(config: Pick<SpaceApiConfig, "host" | "port" | "browserEvidenceTargetOrigin">): string {
  if (config.browserEvidenceTargetOrigin) {
    return config.browserEvidenceTargetOrigin.replace(/\/+$/, "");
  }
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}
