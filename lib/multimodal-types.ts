/**
 * Multimodal Chat Runtime Extension — Типы и структуры данных
 * Соответствует дополнительному техническому заданию (Multimodal Chat Runtime Extension TZ)
 */

export type ModelCapability =
  | "CHAT"
  | "CODING"
  | "REASONING"
  | "TEXT_INPUT"
  | "TEXT_OUTPUT"
  | "VISION_INPUT"
  | "IMAGE_INPUT"
  | "IMAGE_OUTPUT"
  | "IMAGE_GENERATION"
  | "IMAGE_EDITING"
  | "AUDIO_INPUT"
  | "AUDIO_OUTPUT"
  | "AUDIO_GENERATION"
  | "TEXT_TO_SPEECH"
  | "SPEECH_TO_TEXT"
  | "VIDEO_INPUT"
  | "VIDEO_OUTPUT"
  | "VIDEO_GENERATION"
  | "FILE_INPUT"
  | "DOCUMENT_READING"
  | "TOOL_CALLING"
  | "STRUCTURED_OUTPUT"
  | "EMBEDDING"
  | "RERANK"
  | "MODERATION"
  | "OCR"
  | "UNKNOWN";

export type Modality = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "FILE" | "EMBEDDING";

export type ModelAccessTier =
  | "FREE"
  | "PAID"
  | "FREE_WITH_LIMITS"
  | "TRIAL"
  | "LOCAL"
  | "UNKNOWN";

export type PricingSource =
  | "PROVIDER_API"
  | "PROVIDER_METADATA"
  | "VERIFIED_LOCAL_METADATA"
  | "USER_DEFINED"
  | "UNKNOWN";

export interface ModelPricing {
  inputTokenPrice?: number;
  outputTokenPrice?: number;
  imageGenerationPrice?: number;
  audioGenerationPrice?: number;
  videoGenerationPrice?: number;
  perSecondAudioPrice?: number;
  perSecondVideoPrice?: number;
  currency?: string;
  source: PricingSource;
}

export type ModelAvailability = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";

export interface NormalizedModel {
  id: string;
  name: string;
  providerId: string;
  capabilities: ModelCapability[];
  inputModalities: Modality[];
  outputModalities: Modality[];
  supportsChat: boolean;
  supportsCoding: boolean;
  supportsReasoning: boolean;
  supportsImageInput: boolean;
  supportsImageGeneration: boolean;
  supportsImageEditing: boolean;
  supportsAudioInput: boolean;
  supportsAudioGeneration: boolean;
  supportsTts: boolean;
  supportsStt: boolean;
  supportsVideoInput: boolean;
  supportsVideoGeneration: boolean;
  supportsFiles: boolean;
  supportsDocumentReading: boolean;
  supportsEmbeddings: boolean;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  accessTier: ModelAccessTier;
  availability: ModelAvailability;
  rawMetadata?: unknown;
}

export interface FallbackPolicy {
  allowAutomaticFallback: boolean;
  allowFreeToFree: boolean;
  allowPaidToPaid: boolean;
  allowFreeToPaid: boolean;
  allowPaidToFree: boolean;
  allowCrossProvider: boolean;
  maxPaidCostPerRequest?: number;
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  allowAutomaticFallback: true,
  allowFreeToFree: true,
  allowPaidToPaid: true,
  allowFreeToPaid: false, // Строго запрещён автоматический платный fallback без диалога
  allowPaidToFree: true,
  allowCrossProvider: false,
};

export type TaskType =
  | "CHAT"
  | "CODING"
  | "IMAGE_ANALYSIS"
  | "IMAGE_GENERATION"
  | "IMAGE_EDITING"
  | "AUDIO_ANALYSIS"
  | "AUDIO_GENERATION"
  | "SPEECH_TO_TEXT"
  | "TEXT_TO_SPEECH"
  | "VIDEO_ANALYSIS"
  | "VIDEO_GENERATION"
  | "DOCUMENT_ANALYSIS"
  | "FILE_ANALYSIS"
  | "EMBEDDING_INDEXING"
  | "UNKNOWN";

export type AttachmentType =
  | "IMAGE"
  | "AUDIO"
  | "VIDEO"
  | "PDF"
  | "DOCUMENT"
  | "SPREADSHEET"
  | "PRESENTATION"
  | "SOURCE_CODE"
  | "TEXT"
  | "ARCHIVE"
  | "JSON"
  | "XML"
  | "BINARY"
  | "UNKNOWN";

export interface ChatAttachment {
  id: string;
  uri: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  extension: string;
  attachmentType: AttachmentType;
  localState: "READY" | "PROCESSING" | "ERROR";
  source?: "GALLERY" | "CAMERA" | "FILE" | "GENERATED";
  parsedExcerpt?: string;
  metadata?: Record<string, unknown>;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; uri: string; mimeType?: string; name?: string; source?: "GALLERY" | "CAMERA" }
  | { type: "audio"; uri: string; mimeType?: string; durationSec?: number; name?: string }
  | { type: "video"; uri: string; mimeType?: string; durationSec?: number; name?: string }
  | { type: "file"; uri: string; mimeType?: string; name: string; sizeBytes?: number; parsedText?: string };

export interface MediaJob {
  jobId: string;
  taskType: TaskType;
  providerId: string;
  modelId: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress?: number;
  resultUri?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
