import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";

const googleClient = new OAuth2Client();
const GOOGLE_SUBJECT_MAX_LENGTH = 255;

export type GoogleIdentity = { sub: string };
export type GoogleIdTokenVerifier = (token: string, audience: string) => Promise<GoogleIdentity | null>;

async function verifyWithGoogle(token: string, audience: string): Promise<GoogleIdentity | null> {
  const ticket = await googleClient.verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload();
  return payload?.sub ? { sub: payload.sub } : null;
}

export function stableGoogleUserId(subject: string): string {
  if (!subject || subject.length > GOOGLE_SUBJECT_MAX_LENGTH) throw new Error("Invalid Google subject");
  return createHash("sha256").update(`google\0${subject}`).digest("hex");
}

export function createGoogleIdentityMiddleware(
  verifier: GoogleIdTokenVerifier = verifyWithGoogle,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authorization = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._~-]{20,8192})$/.exec(authorization);
    if (!match) {
      res.status(401).json({ error: "Sign in with Google to use your study library.", code: "RAG_AUTH_REQUIRED" });
      return;
    }

    const audience = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!audience) {
      res.status(503).json({ error: "Google sign-in is not configured on the server.", code: "GOOGLE_AUTH_NOT_CONFIGURED" });
      return;
    }

    try {
      const identity = await verifier(match[1]!, audience);
      if (!identity?.sub) {
        res.status(401).json({ error: "Your Google sign-in could not be verified. Please sign in again.", code: "INVALID_GOOGLE_TOKEN" });
        return;
      }
      res.locals.ragUserId = stableGoogleUserId(identity.sub);
      next();
    } catch {
      // Never log bearer tokens or provider verification details.
      res.status(401).json({ error: "Your Google sign-in could not be verified. Please sign in again.", code: "INVALID_GOOGLE_TOKEN" });
    }
  };
}
