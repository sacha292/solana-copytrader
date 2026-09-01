import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { log } from "../logger.js";

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, { count: number; resetAt: number }>();

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export function requirePassword(expected: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const key = request.ip ?? "unknown";

    if (rateLimited(key)) {
      log.warn(`Trop de tentatives depuis ${key}`);
      response.status(429).json({ success: false, error: "Trop de tentatives, reessaie dans une minute" });
      return;
    }

    const supplied = request.get("x-dashboard-password") ?? "";
    if (!constantTimeEqual(supplied, expected)) {
      response.status(401).json({ success: false, error: "Mot de passe incorrect" });
      return;
    }

    // A correct password clears the counter so normal use is never throttled.
    attempts.delete(key);
    next();
  };
}
