/**
 * Multimodal Request Router & Task Classifier
 * Интеллектуальная маршрутизация мультимодальных запросов, определение типа задачи,
 * проверка capabilities и защита от нежелательных платных списаний (FREE -> PAID guard).
 */

import type {
  ChatAttachment,
  FallbackPolicy,
  ModelCapability,
  NormalizedModel,
  TaskType,
} from "./multimodal-types";
import { DEFAULT_FALLBACK_POLICY } from "./multimodal-types";

export interface TaskClassification {
  taskType: TaskType;
  requiredCapabilities: ModelCapability[];
  requiresImageInput: boolean;
  requiresVision: boolean;
  requiresAudioInput: boolean;
  requiresAudioOutput: boolean;
  requiresVideoInput: boolean;
  requiresVideoOutput: boolean;
  requiresImageGeneration: boolean;
  requiresDocumentReading: boolean;
  confidence: number;
}

/**
 * Классифицирует тип задачи по тексту запроса и прикреплённым вложениям
 */
export function classifyMultimodalTask(
  prompt: string,
  attachments: ChatAttachment[] = []
): TaskClassification {
  const p = prompt.trim().toLowerCase();
  const hasImage = attachments.some((a) => a.attachmentType === "IMAGE");
  const hasAudio = attachments.some((a) => a.attachmentType === "AUDIO");
  const hasVideo = attachments.some((a) => a.attachmentType === "VIDEO");
  const hasDoc = attachments.some(
    (a) => a.attachmentType === "PDF" || a.attachmentType === "DOCUMENT" || a.attachmentType === "SPREADSHEET"
  );
  const hasCode = attachments.some(
    (a) => a.attachmentType === "SOURCE_CODE" || a.attachmentType === "ARCHIVE"
  );

  // 1. Генерация изображений
  if (
    /^(нарисуй|создай (рисунок|картинк|изображен)|сгенерируй (картинк|изображен)|draw|paint|generate (an? )?image|generate (a )?picture)(?:[\s,.;:!?]|$)/i.test(
      p
    ) &&
    !hasImage
  ) {
    return {
      taskType: "IMAGE_GENERATION",
      requiredCapabilities: ["IMAGE_GENERATION", "IMAGE_OUTPUT"],
      requiresImageInput: false,
      requiresVision: false,
      requiresAudioInput: false,
      requiresAudioOutput: false,
      requiresVideoInput: false,
      requiresVideoOutput: false,
      requiresImageGeneration: true,
      requiresDocumentReading: false,
      confidence: 0.95,
    };
  }

  // 2. Редактирование изображений
  if (
    hasImage &&
    /(измени|отредактируй|поменяй|удали фон|дорисуй|edit (the )?image|modify (the )?image)/i.test(p)
  ) {
    return {
      taskType: "IMAGE_EDITING",
      requiredCapabilities: ["IMAGE_INPUT", "IMAGE_EDITING", "IMAGE_OUTPUT"],
      requiresImageInput: true,
      requiresVision: true,
      requiresAudioInput: false,
      requiresAudioOutput: false,
      requiresVideoInput: false,
      requiresVideoOutput: false,
      requiresImageGeneration: false,
      requiresDocumentReading: false,
      confidence: 0.9,
    };
  }

  // 3. Анализ изображений (Vision)
  if (hasImage) {
    return {
      taskType: "IMAGE_ANALYSIS",
      requiredCapabilities: ["IMAGE_INPUT", "VISION_INPUT", "CHAT"],
      requiresImageInput: true,
      requiresVision: true,
      requiresAudioInput: false,
      requiresAudioOutput: false,
      requiresVideoInput: false,
      requiresVideoOutput: false,
      requiresImageGeneration: false,
      requiresDocumentReading: false,
      confidence: 0.95,
    };
  }

  // 4. Генерация видео
  if (
    /(создай видео|сгенерируй видео|анимируй|сделай анимацию|generate (a )?video|create (a )?video)(?:[\s,.;:!?]|$)/i.test(
      p
    )
  ) {
    return {
      taskType: "VIDEO_GENERATION",
      requiredCapabilities: ["VIDEO_GENERATION", "VIDEO_OUTPUT"],
      requiresImageInput: hasImage,
      requiresVision: hasImage,
      requiresAudioInput: false,
      requiresAudioOutput: false,
      requiresVideoInput: false,
      requiresVideoOutput: true,
      requiresImageGeneration: false,
      requiresDocumentReading: false,
      confidence: 0.9,
    };
  }

  // 5. Text to Speech (TTS)
  if (
    /(озвучь( этот)? текст|прочитай вслух|произнеси|text to speech|tts|speak this)(?:[\s,.;:!?]|$)/i.test(p)
  ) {
    return {
      taskType: "TEXT_TO_SPEECH",
      requiredCapabilities: ["TEXT_TO_SPEECH", "AUDIO_OUTPUT"],
      requiresImageInput: false,
      requiresVision: false,
      requiresAudioInput: false,
      requiresAudioOutput: true,
      requiresVideoInput: false,
      requiresVideoOutput: false,
      requiresImageGeneration: false,
      requiresDocumentReading: false,
      confidence: 0.9,
    };
  }

  // 6. Speech to Text (STT)
  if (hasAudio && /(расшифруй|транскрибируй|переведи в текст|stt|transcribe)\b/i.test(p)) {
    return {
      taskType: "SPEECH_TO_TEXT",
      requiredCapabilities: ["SPEECH_TO_TEXT", "AUDIO_INPUT"],
      requiresImageInput: false,
      requiresVision: false,
      requiresAudioInput: true,
      requiresAudioOutput: false,
      requiresVideoInput: false,
      requiresVideoOutput: false,
      requiresImageGeneration: false,
      requiresDocumentReading: false,
      confidence: 0.9,
    };
  }

  // 7. Анализ документов
  if (hasDoc) {
    return {
      taskType: "DOCUMENT_ANALYSIS",
      requiredCapabilities: ["DOCUMENT_READING", "FILE_INPUT", "CHAT"],
      requiresImageInput: false,
      requiresVision: false,
      requiresAudioInput: false,
      requiresAudioOutput: false,
      requiresVideoInput: false,
      requiresVideoOutput: false,
      requiresImageGeneration: false,
      requiresDocumentReading: true,
      confidence: 0.85,
    };
  }

  // 8. Кодинг / Разработка
  if (
    hasCode ||
    /(напиши код|исправь ошибку|собери приложение|создай функцию|напиши скрипт|debug|refactor|compile|build|gradle|apk)/i.test(
      p
    )
  ) {
    return {
      taskType: "CODING",
      requiredCapabilities: ["CODING", "CHAT"],
      requiresImageInput: false,
      requiresVision: false,
      requiresAudioInput: false,
      requiresAudioOutput: false,
      requiresVideoInput: false,
      requiresVideoOutput: false,
      requiresImageGeneration: false,
      requiresDocumentReading: false,
      confidence: 0.85,
    };
  }

  // 9. Стандартный диалог
  return {
    taskType: "CHAT",
    requiredCapabilities: ["CHAT", "TEXT_INPUT", "TEXT_OUTPUT"],
    requiresImageInput: false,
    requiresVision: false,
    requiresAudioInput: false,
    requiresAudioOutput: false,
    requiresVideoInput: false,
    requiresVideoOutput: false,
    requiresImageGeneration: false,
    requiresDocumentReading: false,
    confidence: 0.8,
  };
}

export interface RoutingDecision {
  action: "EXECUTE" | "REQUIRE_CONFIRMATION" | "UNSUPPORTED";
  targetModel?: NormalizedModel;
  reason: string;
  isPaidUpgrade?: boolean;
}

/**
 * Подбирает совместимую модель с учётом FallbackPolicy и строгого контроля платного перехода
 */
export function routeMultimodalRequest(
  classification: TaskClassification,
  currentModel: NormalizedModel,
  availableModels: NormalizedModel[],
  policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY
): RoutingDecision {
  // 1. Проверяем, поддерживает ли текущая модель все требуемые возможности
  const currentSupportsAll = classification.requiredCapabilities.every((cap) =>
    currentModel.capabilities.includes(cap)
  );

  if (currentSupportsAll) {
    return {
      action: "EXECUTE",
      targetModel: currentModel,
      reason: `Текущая модель ${currentModel.name} поддерживает все необходимые возможности`,
      isPaidUpgrade: false,
    };
  }

  // 2. Ищем кандидатов среди доступных моделей
  const matchingCandidates = availableModels.filter((m) =>
    classification.requiredCapabilities.every((cap) => m.capabilities.includes(cap))
  );

  if (matchingCandidates.length === 0) {
    return {
      action: "UNSUPPORTED",
      reason: `Ни одна доступная модель не поддерживает возможности: ${classification.requiredCapabilities.join(", ")}`,
    };
  }

  // 3. Разделяем бесплатных и платных кандидатов
  const freeCandidates = matchingCandidates.filter(
    (m) => m.accessTier === "FREE" || m.accessTier === "LOCAL"
  );
  const paidCandidates = matchingCandidates.filter(
    (m) => m.accessTier === "PAID" || m.accessTier === "FREE_WITH_LIMITS"
  );

  // 4. Если текущая модель БЕСПЛАТНАЯ
  const isCurrentFree = currentModel.accessTier === "FREE" || currentModel.accessTier === "LOCAL";

  if (isCurrentFree) {
    if (freeCandidates.length > 0 && policy.allowFreeToFree) {
      // Найдена подходящая бесплатная модель
      return {
        action: "EXECUTE",
        targetModel: freeCandidates[0],
        reason: `Автоматическое переключение на совместимую бесплатную модель ${freeCandidates[0].name}`,
        isPaidUpgrade: false,
      };
    }

    // Бесплатных кандидатов нет. Доступны только платные
    if (paidCandidates.length > 0) {
      if (policy.allowFreeToPaid) {
        return {
          action: "EXECUTE",
          targetModel: paidCandidates[0],
          reason: `Переключение на платную модель ${paidCandidates[0].name} (разрешено политикой)`,
          isPaidUpgrade: true,
        };
      } else {
        // ТЗ: Никогда не переключать FREE -> PAID незаметно!
        return {
          action: "REQUIRE_CONFIRMATION",
          targetModel: paidCandidates[0],
          reason: `Для выполнения операции (${classification.taskType}) требуется платная модель ${paidCandidates[0].name}. Требуется подтверждение.`,
          isPaidUpgrade: true,
        };
      }
    }
  }

  // 5. Если текущая модель ПЛАТНАЯ
  if (paidCandidates.length > 0 && policy.allowPaidToPaid) {
    return {
      action: "EXECUTE",
      targetModel: paidCandidates[0],
      reason: `Переключение на совместимую модель ${paidCandidates[0].name}`,
      isPaidUpgrade: false,
    };
  }

  if (freeCandidates.length > 0 && policy.allowPaidToFree) {
    return {
      action: "EXECUTE",
      targetModel: freeCandidates[0],
      reason: `Переключение на бесплатную совместимую модель ${freeCandidates[0].name}`,
      isPaidUpgrade: false,
    };
  }

  return {
    action: "UNSUPPORTED",
    reason: "Не удалось подобрать модель, соответствующую политике расходов",
  };
}

/**
 * Удобная обёртка для маршрутизации по типу задачи с гарантией проверки Free -> Paid
 */
const MODEL_CAPABILITIES = new Set<ModelCapability>(["CHAT", "CODING", "REASONING", "TEXT_INPUT", "TEXT_OUTPUT", "VISION_INPUT", "IMAGE_INPUT", "IMAGE_OUTPUT", "IMAGE_GENERATION", "IMAGE_EDITING", "AUDIO_INPUT", "AUDIO_OUTPUT", "AUDIO_GENERATION", "TEXT_TO_SPEECH", "SPEECH_TO_TEXT", "VIDEO_INPUT", "VIDEO_OUTPUT", "VIDEO_GENERATION", "FILE_INPUT", "DOCUMENT_READING", "TOOL_CALLING", "STRUCTURED_OUTPUT", "EMBEDDING", "RERANK", "MODERATION", "OCR", "UNKNOWN"]);

export function routeMultimodalTask(params: {
  taskType: TaskType | string;
  preferredAccessTier?: string;
  availableModels: any[];
  fallbackPolicy?: FallbackPolicy;
}) {
  const normModels: NormalizedModel[] = params.availableModels.map((m) => {
    const rawCapabilities: unknown[] = Array.isArray(m.capabilities)
      ? m.capabilities
      : m.vision
        ? ["VISION_INPUT", "CHAT"]
        : ["CHAT"];
    const capabilities = rawCapabilities
      .map((cap) => cap === "VISION" ? "VISION_INPUT" : cap)
      .filter((cap): cap is ModelCapability => typeof cap === "string" && MODEL_CAPABILITIES.has(cap as ModelCapability));
    return {
    id: m.id,
    name: m.name || m.id,
    providerId: m.provider || "OpenRouter",
    capabilities,
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    supportsChat: true,
    supportsCoding: true,
    supportsReasoning: false,
    supportsImageInput: capabilities.includes("VISION_INPUT") || !!m.vision,
    supportsImageGeneration: !!m.capabilities?.includes("IMAGE_GENERATION"),
    supportsImageEditing: false,
    supportsAudioInput: false,
    supportsAudioGeneration: false,
    supportsTts: false,
    supportsStt: false,
    supportsVideoInput: false,
    supportsVideoGeneration: false,
    supportsFiles: true,
    supportsDocumentReading: true,
    supportsEmbeddings: false,
    supportsTools: false,
    supportsStructuredOutput: false,
    accessTier: m.accessTier || "FREE",
    availability: "AVAILABLE",
  };
  });

  const requiredCaps: ModelCapability[] =
    params.taskType === "IMAGE_ANALYSIS" || params.taskType === "VISION_ANALYSIS"
      ? ["VISION_INPUT"]
      : params.taskType === "IMAGE_GENERATION"
      ? ["IMAGE_GENERATION"]
      : ["CHAT"];

  const dummyClassification: TaskClassification = {
    taskType: (params.taskType === "VISION_ANALYSIS" ? "IMAGE_ANALYSIS" : params.taskType) as TaskType,
    requiredCapabilities: requiredCaps,
    requiresImageInput: params.taskType === "IMAGE_ANALYSIS" || params.taskType === "VISION_ANALYSIS",
    requiresVision: params.taskType === "IMAGE_ANALYSIS" || params.taskType === "VISION_ANALYSIS",
    requiresAudioInput: false,
    requiresAudioOutput: false,
    requiresVideoInput: false,
    requiresVideoOutput: false,
    requiresImageGeneration: params.taskType === "IMAGE_GENERATION",
    requiresDocumentReading: params.taskType === "DOCUMENT_ANALYSIS",
    confidence: 1,
  };

  const currentModel =
    normModels.find((m) => m.accessTier === (params.preferredAccessTier || "FREE")) || normModels[0];

  const decision = routeMultimodalRequest(dummyClassification, currentModel, normModels, params.fallbackPolicy);
  return {
    ...decision,
    fallbackAction: decision.action,
  };
}
