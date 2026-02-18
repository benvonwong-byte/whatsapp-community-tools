import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "../config";

export function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Admin auth: checks ?token= query param or Authorization: Bearer header */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = (req.query.token as string) || req.headers.authorization?.replace("Bearer ", "");
  if (!token || !timingSafeEqual(token, config.adminToken)) {
    res.status(401).json({ error: "Unauthorized. Provide ?token=<ADMIN_TOKEN> or Authorization header." });
    return;
  }
  (res as any).locals.role = "admin";
  next();
}

/** Auth: accepts both admin and guest tokens */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = (req.query.token as string) || req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  if (timingSafeEqual(token, config.adminToken)) {
    (res as any).locals.role = "admin";
    next();
    return;
  }
  if (timingSafeEqual(token, config.guestToken)) {
    (res as any).locals.role = "guest";
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized." });
}

/** Block guest users from mutating endpoints — admin only */
export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  if ((res as any).locals.role !== "admin") {
    res.status(403).json({ error: "Admin access required for this action." });
    return;
  }
  next();
}
