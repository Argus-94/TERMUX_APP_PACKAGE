/**
 * Media Generation Module — Генерация изображений и медиа без Termux
 * Соответствует разделам 20-25, 71-75 ТЗ (Multimodal Chat Runtime Extension)
 */

import { Paths, File } from "expo-file-system";
import type { ChatAttachment } from "./multimodal-types";

export interface ImageGenerationOptions {
  width?: number;
  height?: number;
  seed?: number;
  model?: string;
  nologo?: boolean;
}

/**
 * Генерирует изображение по текстовому описанию без использования Termux.
 * Использует прямой REST API (Pollinations AI Flux/SDXL или совместимый провайдер),
 * сохраняет файл в локальное хранилище и возвращает ChatAttachment.
 */
export async function generateImageFromPrompt(
  prompt: string,
  options: ImageGenerationOptions = {}
): Promise<ChatAttachment> {
  const cleanPrompt = prompt.trim();
  const width = options.width || 1024;
  const height = options.height || 1024;
  const seed = options.seed || Math.floor(Math.random() * 1000000);

  // Формируем URL генерации
  const encoded = encodeURIComponent(cleanPrompt);
  const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&nologo=true`;

  const fileName = `gen_${Date.now()}_${seed}.jpg`;
  const targetDir = Paths.cache;
  const localFile = new File(targetDir, fileName);

  try {
    // Скачиваем сгенерированное изображение локально
    const downloaded = await File.downloadFileAsync(imageUrl, localFile);
    return {
      id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      uri: downloaded.uri,
      displayName: `Сгенерированное изображение: ${cleanPrompt.slice(0, 30)}...`,
      mimeType: "image/jpeg",
      sizeBytes: downloaded.size ?? 0,
      extension: "jpg",
      attachmentType: "IMAGE",
      localState: "READY",
      source: "GENERATED",
      metadata: {
        prompt: cleanPrompt,
        provider: "Pollinations / Flux",
        width,
        height,
        seed,
        createdAt: Date.now(),
      },
    };
  } catch {
    // В случае сбоя скачивания возвращаем удалённый URI
    return {
      id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      uri: imageUrl,
      displayName: `Изображение: ${cleanPrompt.slice(0, 30)}...`,
      mimeType: "image/jpeg",
      sizeBytes: 0,
      extension: "jpg",
      attachmentType: "IMAGE",
      localState: "READY",
      source: "GENERATED",
      metadata: {
        prompt: cleanPrompt,
        provider: "Pollinations / Flux",
        width,
        height,
        seed,
        createdAt: Date.now(),
      },
    };
  }
}
