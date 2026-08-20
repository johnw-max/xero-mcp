import { z } from "zod/v4";
import {
  trackingCategoryCreateSchema,
  trackingCategoryUpdateSchema,
  trackingOptionCreateSchema,
  trackingOptionUpdateSchema,
  type TrackingCategoryCreateInput,
  type TrackingCategoryUpdateInput,
  type TrackingOptionCreateInput,
  type TrackingOptionUpdateInput,
} from "./xeroTrackingMutationSchemas.js";

export const TRACKING_ACTION_IDS = Object.freeze([
  "tracking_category.create",
  "tracking_category.update",
  "tracking_option.create",
  "tracking_option.update",
] as const);

export type TrackingActionId = typeof TRACKING_ACTION_IDS[number];

export const TRACKING_ADAPTER_OPERATIONS = Object.freeze({
  "tracking_category.create": "XeroTrackingMutationProvider.createCategory",
  "tracking_category.update": "XeroTrackingMutationProvider.updateCategory",
  "tracking_option.create": "XeroTrackingMutationProvider.createOption",
  "tracking_option.update": "XeroTrackingMutationProvider.updateOption",
} as const satisfies Readonly<Record<TrackingActionId, string>>);

const categoryCreateCanonicalSchema = z.object({
  actionId: z.literal("tracking_category.create"),
  name: z.string().min(1).max(100),
}).strict();

const categoryUpdateCanonicalSchema = z.object({
  actionId: z.literal("tracking_category.update"),
  trackingCategoryId: z.string().uuid().transform((value) => value.toLowerCase()),
  name: z.string().min(1).max(100),
}).strict();

const optionCreateCanonicalSchema = z.object({
  actionId: z.literal("tracking_option.create"),
  trackingCategoryId: z.string().uuid().transform((value) => value.toLowerCase()),
  name: z.string().min(1).max(100),
}).strict();

const optionUpdateCanonicalSchema = z.object({
  actionId: z.literal("tracking_option.update"),
  trackingCategoryId: z.string().uuid().transform((value) => value.toLowerCase()),
  trackingOptionId: z.string().uuid().transform((value) => value.toLowerCase()),
  name: z.string().min(1).max(100),
}).strict();

export const trackingCategoryCreateCanonicalSchema = categoryCreateCanonicalSchema;
export const trackingCategoryUpdateCanonicalSchema = categoryUpdateCanonicalSchema;
export const trackingOptionCreateCanonicalSchema = optionCreateCanonicalSchema;
export const trackingOptionUpdateCanonicalSchema = optionUpdateCanonicalSchema;

export type TrackingCategoryCreateCanonicalPayload = z.infer<typeof categoryCreateCanonicalSchema>;
export type TrackingCategoryUpdateCanonicalPayload = z.infer<typeof categoryUpdateCanonicalSchema>;
export type TrackingOptionCreateCanonicalPayload = z.infer<typeof optionCreateCanonicalSchema>;
export type TrackingOptionUpdateCanonicalPayload = z.infer<typeof optionUpdateCanonicalSchema>;

export type TrackingCanonicalPayload =
  | TrackingCategoryCreateCanonicalPayload
  | TrackingCategoryUpdateCanonicalPayload
  | TrackingOptionCreateCanonicalPayload
  | TrackingOptionUpdateCanonicalPayload;

export function canonicalTrackingCategoryCreatePayload(
  input: TrackingCategoryCreateInput,
): TrackingCategoryCreateCanonicalPayload {
  return categoryCreateCanonicalSchema.parse({ actionId: "tracking_category.create", ...trackingCategoryCreateSchema.parse(input) });
}

export function canonicalTrackingCategoryUpdatePayload(
  input: TrackingCategoryUpdateInput,
): TrackingCategoryUpdateCanonicalPayload {
  return categoryUpdateCanonicalSchema.parse({ actionId: "tracking_category.update", ...trackingCategoryUpdateSchema.parse(input) });
}

export function canonicalTrackingOptionCreatePayload(
  input: TrackingOptionCreateInput,
): TrackingOptionCreateCanonicalPayload {
  return optionCreateCanonicalSchema.parse({ actionId: "tracking_option.create", ...trackingOptionCreateSchema.parse(input) });
}

export function canonicalTrackingOptionUpdatePayload(
  input: TrackingOptionUpdateInput,
): TrackingOptionUpdateCanonicalPayload {
  return optionUpdateCanonicalSchema.parse({ actionId: "tracking_option.update", ...trackingOptionUpdateSchema.parse(input) });
}

export function parseTrackingCanonicalPayload(input: unknown): TrackingCanonicalPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tracking canonical payload must be an object.");
  }
  const actionId = (input as { actionId?: unknown }).actionId;
  switch (actionId) {
    case "tracking_category.create": return categoryCreateCanonicalSchema.parse(input);
    case "tracking_category.update": return categoryUpdateCanonicalSchema.parse(input);
    case "tracking_option.create": return optionCreateCanonicalSchema.parse(input);
    case "tracking_option.update": return optionUpdateCanonicalSchema.parse(input);
    default: return z.never().parse(actionId);
  }
}
