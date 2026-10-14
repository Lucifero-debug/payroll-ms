import { PrismaClient } from "@prisma/client";

/*
  One Prisma client, reused. Next.js reloads modules constantly in
  development, and a new client per reload exhausts the database's
  connections within minutes.
*/

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
