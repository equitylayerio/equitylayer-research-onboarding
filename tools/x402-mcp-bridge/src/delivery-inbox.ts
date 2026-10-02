import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { P1A_CAPABILITY_ID, P1A_CAPABILITY_VERSION, P1A_SOURCE_URL } from "./policy.js";

export const LOCAL_DELIVERY_INBOX_ENV = "EQUITYLAYER_LOCAL_DELIVERY_INBOX_PATH";
const LOCAL_DELIVERY_INBOX_VERSION = "0.1.0";
const MAX_DELIVERIES = 20;

const deliverySchema = z.object({
  task_id: z.string().min(1),
  capability_id: z.literal(P1A_CAPABILITY_ID),
  capability_version: z.literal(P1A_CAPABILITY_VERSION),
  received_at: z.string().datetime({ offset: true }),
  output_hash: z.string().regex(/^[a-f0-9]{64}$/),
  symbols: z.array(z.string()).min(1).max(10),
  report_period: z.string().min(1),
  as_of_date: z.string().min(1),
  source: z.object({
    publisher: z.literal("Taiwan Stock Exchange Corporation"),
    url: z.literal(P1A_SOURCE_URL),
  }).strict(),
  summary: z.string().min(1),
  impact_path: z.string().min(1),
  what_it_supports: z.array(z.string()),
  what_it_does_not_prove: z.array(z.string()),
  next_trigger: z.string().min(1),
  receipt: z.object({
    receipt_id: z.string().min(1),
    status: z.literal("settled"),
    transaction_reference: z.string().min(1),
    settled_at: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

const inboxSchema = z.object({
  version: z.literal(LOCAL_DELIVERY_INBOX_VERSION),
  owner: z.literal("caller"),
  persistence: z.literal("local_only"),
  updated_at: z.string().datetime({ offset: true }),
  deliveries: z.array(deliverySchema).max(MAX_DELIVERIES),
}).strict();

type Inbox = z.infer<typeof inboxSchema>;

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("local_delivery_projection_invalid");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("local_delivery_projection_invalid");
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("local_delivery_projection_invalid");
  }
  return value as string[];
}

function projectDelivery(result: Record<string, unknown>, receivedAt: string) {
  const scope = objectValue(result.input_scope);
  const pack = objectValue(result.research_pack);
  const readthrough = objectValue(pack.research_readthrough);
  const receipt = objectValue(result.receipt);

  return deliverySchema.parse({
    task_id: result.task_id,
    capability_id: result.capability_id,
    capability_version: result.capability_version,
    received_at: receivedAt,
    output_hash: result.output_hash,
    symbols: stringArray(scope.symbols),
    report_period: stringValue(pack.report_period),
    as_of_date: stringValue(pack.as_of_date),
    source: {
      publisher: "Taiwan Stock Exchange Corporation",
      url: P1A_SOURCE_URL,
    },
    summary: stringValue(readthrough.summary),
    impact_path: stringValue(readthrough.impact_path),
    what_it_supports: stringArray(readthrough.what_it_supports),
    what_it_does_not_prove: stringArray(readthrough.what_it_does_not_prove),
    next_trigger: stringValue(readthrough.next_trigger),
    receipt: {
      receipt_id: receipt.receipt_id,
      status: receipt.status,
      transaction_reference: receipt.transaction_reference,
      settled_at: receipt.settled_at,
    },
  });
}

async function readInbox(inboxPath: string, now: string): Promise<Inbox> {
  try {
    const metadata = await lstat(inboxPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("local_delivery_inbox_invalid");
    return inboxSchema.parse(JSON.parse(await readFile(inboxPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: LOCAL_DELIVERY_INBOX_VERSION,
      owner: "caller",
      persistence: "local_only",
      updated_at: now,
      deliveries: [],
    };
  }
}

export async function publishLocalDelivery(
  inboxPath: string,
  result: Record<string, unknown>,
  now = new Date().toISOString(),
): Promise<void> {
  if (!isAbsolute(inboxPath)) throw new Error("local_delivery_inbox_path_invalid");
  const parent = dirname(inboxPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const current = await readInbox(inboxPath, now);
  const delivery = projectDelivery(result, now);
  const next = inboxSchema.parse({
    ...current,
    updated_at: now,
    deliveries: [
      delivery,
      ...current.deliveries.filter((item) => (
        item.task_id !== delivery.task_id && item.output_hash !== delivery.output_hash
      )),
    ].slice(0, MAX_DELIVERIES),
  });
  const temporaryPath = join(parent, `.${randomUUID()}.delivery.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, inboxPath);
    await chmod(inboxPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function publishLocalDeliveryFromEnv(
  result: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const inboxPath = env[LOCAL_DELIVERY_INBOX_ENV]?.trim();
  if (!inboxPath) return false;
  await publishLocalDelivery(inboxPath, result);
  return true;
}
