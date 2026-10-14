import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, asc, desc, eq, ilike, lt, or, type SQL } from "drizzle-orm";
import { authRequiredProcedure } from "../context";
import { auditLog } from "../../db/schema";
import { auditActions, verifyAuditChain } from "../../lib/audit";

/** Turn "relation audit_log does not exist" into an actionable error. */
async function withAuditTable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code === "42P01")
      throw new ORPCError("PRECONDITION_FAILED", {
        message:
          "The audit_log table doesn't exist yet. Run `bun run db:push` to create it.",
      });
    throw err;
  }
}

/** Lockdown users only: they are indigest's admins. */
const adminProcedure = authRequiredProcedure.use(async ({ context, next }) => {
  const slackId = context.session.user.slackId;
  if (!slackId || !context.lockdownUsers.includes(slackId))
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  return next();
});

export const listAuditLog = adminProcedure
  .route({ method: "GET", path: "/admin/audit" })
  .input(
    z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.coerce.number().int().optional(),
      action: z.string().max(100).optional(),
      outcome: z.enum(["success", "failure", "denied"]).optional(),
      source: z.enum(["web", "api", "slack", "auth", "system"]).optional(),
      targetId: z.string().max(100).optional(),
      q: z.string().max(100).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const where: SQL[] = [];
    if (input.before) where.push(lt(auditLog.id, input.before));
    if (input.action) where.push(eq(auditLog.action, input.action));
    if (input.outcome) where.push(eq(auditLog.outcome, input.outcome));
    if (input.source) where.push(eq(auditLog.source, input.source));
    if (input.targetId) where.push(eq(auditLog.targetId, input.targetId));
    if (input.q) {
      const like = `%${input.q.replace(/[%_\\]/g, "\\$&")}%`;
      where.push(
        or(
          ilike(auditLog.actorName, like),
          ilike(auditLog.actorId, like),
          ilike(auditLog.actorSlackId, like),
          ilike(auditLog.targetId, like),
          ilike(auditLog.targetName, like),
          ilike(auditLog.action, like),
        )!,
      );
    }
    const rows = await withAuditTable(() =>
      context.db
        .select()
        .from(auditLog)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(auditLog.id))
        .limit(input.limit + 1),
    );
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      entries: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      nextBefore: hasMore ? page[page.length - 1]!.id : null,
    };
  });

/** Recompute the hash chain over the whole log. */
export const verifyAuditLog = adminProcedure
  .route({ method: "GET", path: "/admin/audit/verify" })
  .handler(async ({ context }) => {
    const rows = await withAuditTable(() =>
      context.db.select().from(auditLog).orderBy(asc(auditLog.id)),
    );
    const brokenAt = await verifyAuditChain(rows);
    return { ok: brokenAt === null, brokenAt, checked: rows.length };
  });

export const listAuditActions = adminProcedure
  .route({ method: "GET", path: "/admin/audit/actions" })
  .handler(() =>
    Object.values(auditActions).map((a) => ({
      action: a.action,
      description: a.description ?? "",
      severity: a.severity ?? "low",
    })),
  );

export const adminRouter = {
  audit: listAuditLog,
  verifyAudit: verifyAuditLog,
  auditActions: listAuditActions,
};
