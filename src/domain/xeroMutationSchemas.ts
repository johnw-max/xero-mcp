import { z } from "zod/v4";
import {
  XERO_MUTATION_OBJECT_TYPES,
  XERO_MUTATION_OPERATIONS,
  XERO_MUTATION_SOURCE_EVIDENCE_TYPES,
} from "./xeroMutation.js";

const identifier = z.string().trim().min(1).max(255);
const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.unknown());
const nonEmptyJsonObject = jsonObject.refine((value) => Object.keys(value).length > 0, "must not be empty");

export const xeroMutationObjectTypeSchema = z.enum(XERO_MUTATION_OBJECT_TYPES);
export const xeroMutationOperationSchema = z.enum(XERO_MUTATION_OPERATIONS);
export const xeroMutationSourceEvidenceTypeSchema = z.enum(XERO_MUTATION_SOURCE_EVIDENCE_TYPES);

const opaqueSourceRef = z.string().trim().min(1).max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters")
  .refine((value) => !/^https?:\/\//i.test(value), "must be an opaque reference, not a URL")
  .refine((value) => !value.includes("?") && !value.includes("#"), "must not contain URL query or fragment data");

const sourceUnitKey = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

const confirmationPhrase = z.string().min(1).max(256)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

export const prepareXeroMutationSchema = z.object({
  objectType: xeroMutationObjectTypeSchema,
  operation: xeroMutationOperationSchema,
  canonicalPayload: jsonObject,
  sourceRef: opaqueSourceRef.optional(),
  sourceUnitKey,
  sourceSha256: sha256.optional(),
  sourceEvidenceType: xeroMutationSourceEvidenceTypeSchema,
  confirmationDetails: jsonObject,
  confirmationPhrase: confirmationPhrase.optional(),
  targetXeroObjectId: identifier.optional(),
}).strict().superRefine((value, context) => {
  if (value.operation === "UPDATE" && !value.targetXeroObjectId) {
    context.addIssue({ code: "custom", message: "UPDATE requires targetXeroObjectId", path: ["targetXeroObjectId"] });
  }
  if (value.operation !== "UPDATE" && value.targetXeroObjectId) {
    context.addIssue({
      code: "custom",
      message: "targetXeroObjectId is only valid for UPDATE",
      path: ["targetXeroObjectId"],
    });
  }
  if (value.sourceEvidenceType === "AGENT_ASSERTED_UNVERIFIED" && !value.sourceSha256) {
    context.addIssue({
      code: "custom",
      message: "AGENT_ASSERTED_UNVERIFIED requires caller sourceSha256",
      path: ["sourceSha256"],
    });
  }
  if (value.sourceEvidenceType === "SERVER_FINGERPRINTED_EXTRACTION" && value.sourceSha256) {
    context.addIssue({
      code: "custom",
      message: "SERVER_FINGERPRINTED_EXTRACTION sourceSha256 is derived by the server",
      path: ["sourceSha256"],
    });
  }
  if (value.sourceEvidenceType === "SERVER_FINGERPRINTED_EXTRACTION" && !value.sourceRef) {
    context.addIssue({
      code: "custom",
      message: "SERVER_FINGERPRINTED_EXTRACTION requires sourceRef",
      path: ["sourceRef"],
    });
  }
});

export const confirmXeroMutationSchema = z.object({
  preparationId: z.string().regex(/^xmp_[a-f0-9]{32}$/),
  requestId,
  confirmationPhrase,
}).strict();

export const startXeroMutationSchema = z.object({
  mutationRequestId: z.string().regex(/^xmr_[a-f0-9]{32}$/),
}).strict();

export const markXeroMutationUnknownSchema = startXeroMutationSchema.extend({
  xeroObjectId: identifier.optional(),
  writeReceipt: nonEmptyJsonObject.optional(),
}).strict();

export const recordXeroMutationWriteEvidenceSchema = startXeroMutationSchema.extend({
  xeroObjectId: identifier,
  writeReceipt: nonEmptyJsonObject,
}).strict();

export const completeXeroMutationReadbackSchema = z.object({
  mutationRequestId: z.string().regex(/^xmr_[a-f0-9]{32}$/),
  writeReceipt: nonEmptyJsonObject,
  verifiedReadback: z.object({
    xeroObjectId: identifier,
    status: z.string().trim().min(1).max(64),
    canonicalPayload: jsonObject,
    evidence: jsonObject.optional(),
  }).strict(),
}).strict();

export const failXeroMutationValidationSchema = z.object({
  mutationRequestId: z.string().regex(/^xmr_[a-f0-9]{32}$/),
  validationReceipt: jsonObject.optional(),
}).strict();

export const rejectXeroMutationProviderSchema = z.object({
  mutationRequestId: z.string().regex(/^xmr_[a-f0-9]{32}$/),
  providerRejectionReceipt: nonEmptyJsonObject,
}).strict();

export type PrepareXeroMutationInput = z.infer<typeof prepareXeroMutationSchema>;
export type ConfirmXeroMutationInput = z.infer<typeof confirmXeroMutationSchema>;
export type StartXeroMutationInput = z.infer<typeof startXeroMutationSchema>;
export type MarkXeroMutationUnknownInput = z.infer<typeof markXeroMutationUnknownSchema>;
export type RecordXeroMutationWriteEvidenceInput = z.infer<typeof recordXeroMutationWriteEvidenceSchema>;
export type CompleteXeroMutationReadbackInput = z.infer<typeof completeXeroMutationReadbackSchema>;
export type FailXeroMutationValidationInput = z.infer<typeof failXeroMutationValidationSchema>;
export type RejectXeroMutationProviderInput = z.infer<typeof rejectXeroMutationProviderSchema>;
