import { ORPCError } from "@orpc/server";
import { os } from "@orpc/server";
import type { Store } from "../store/store";
import type { ApiKeyIdentity } from "../lib/api-keys";

export interface SessionIdentity {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    slackId?: string | null;
  };
}

export interface ORPCContext {
  store: Store;
  session: SessionIdentity | null;
  apiKey: ApiKeyIdentity | null;
  databaseUrl: string;
}

const base = os.$context<ORPCContext>();

export const publicProcedure = base;

export const authRequiredProcedure = base.use(async ({ context, next }) => {
  if (!context.session) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Authentication required",
    });
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const apiKeyRequiredProcedure = base.use(async ({ context, next }) => {
  if (!context.apiKey) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "API key required",
    });
  }
  return next({
    context: {
      apiKey: context.apiKey,
    },
  });
});

export const authOrApiKeyProcedure = base.use(async ({ context, next }) => {
  if (!context.session && !context.apiKey) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Authentication or API key required",
    });
  }
  return next();
});
