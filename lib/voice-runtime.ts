/**
 * Voice Chat Runtime — Голосовой ввод, синтез речи (TTS) и управление аудио
 * Соответствует ТЗ (Voice Chat Runtime TZ with Camera)
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { Platform } from "react-native";

export interface VoiceSettings {
  voiceInputEnabled: boolean;
  sttEngine: "system" | "local" | "api";
  sttLanguage: "auto" | "ru" | "uk" | "en";
  autoSend: boolean;
  autoSpeakResponses: boolean;
  ttsEngine: "system" | "local" | "api";
  ttsSpeed: number;
  readCodeBlocks: boolean;
  voiceConversationMode: boolean;
  allowCloudVoiceFallback: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceInputEnabled: true,
  sttEngine: "system",
  sttLanguage: "auto",
  autoSend: true,
  autoSpeakResponses: false,
  ttsEngine: "system",
  ttsSpeed: 1.0,
  readCodeBlocks: false,
  voiceConversationMode: false,
  allowCloudVoiceFallback: false,
};

const VOICE_SETTINGS_STORAGE_KEY = "aibuilder.voice.settings.v1";

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await AsyncStorage.getItem(VOICE_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_VOICE_SETTINGS;
    return { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export async function saveVoiceSettings(settings: VoiceSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

/**
 * SpeechContentFormatter — Подготавливает технический текст ответа для озвучивания.
 * Удаляет огромные блоки кода, дампы памяти, stack traces и заменяет их на краткие фразы.
 */
export function formatTextForSpeech(
  text: string,
  options: { readCodeBlocks?: boolean; language?: string } = {}
): string {
  if (!text) return "";
  let formatted = text;

  // 1. Обработка блоков кода ``` ... ```
  if (!options.readCodeBlocks) {
    formatted = formatted.replace(/```(?:[a-zA-Z0-9_-]+)?[\s\S]*?```/g, () => {
      if (options.language === "en") return " [Code block is shown in chat] ";
      if (options.language === "uk") return " [Блок коду показано в чаті] ";
      return " [Блок кода показан в чате] ";
    });
  }

  // 2. Инлайн-код `...`
  formatted = formatted.replace(/`([^`]+)`/g, "$1");

  // 3. Удаление длинных логов сборки / Gradle вывода
  formatted = formatted.replace(/BUILD SUCCESSFUL in[\s\S]*$/gi, () => {
    if (options.language === "en") return " Build completed successfully. ";
    if (options.language === "uk") return " Збірку успішно завершено. ";
    return " Сборка успешно завершена. ";
  });

  // 4. Очистка Markdown разметки
  formatted = formatted
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s+/gm, "")
    .replace(/^[*-]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // 5. Ограничение длины одного воспроизведения (не более 1200 символов)
  if (formatted.length > 1200) {
    const end = formatted.lastIndexOf(".", 1200);
    formatted = (end > 300 ? formatted.slice(0, end + 1) : formatted.slice(0, 1200)) + " ...";
  }

  return formatted;
}

/**
 * Singleton-менеджер аудиовоспроизведения TTS
 */
class VoicePlaybackManager {
  private currentSound: Audio.Sound | null = null;
  private currentPlayingId: string | null = null;
  private readonly statusListeners = new Set<(playingId: string | null) => void>();

  public setStatusListener(callback: (playingId: string | null) => void): () => void {
    this.statusListeners.add(callback);
    callback(this.currentPlayingId);
    return () => this.statusListeners.delete(callback);
  }

  private notifyStatusChange(playingId: string | null): void {
    for (const callback of [...this.statusListeners]) {
      try {
        callback(playingId);
      } catch {
        // One stale UI listener must not prevent updates to the remaining bubbles.
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.currentSound) {
      try {
        await this.currentSound.stopAsync();
        await this.currentSound.unloadAsync();
      } catch {
        // ignore
      }
      this.currentSound = null;
    }
    this.currentPlayingId = null;
    this.notifyStatusChange(null);
  }

  public isPlaying(messageId?: string): boolean {
    if (!this.currentPlayingId) return false;
    if (messageId) return this.currentPlayingId === messageId;
    return true;
  }

  public getCurrentPlayingId(): string | null {
    return this.currentPlayingId;
  }

  /**
   * Синтезирует и воспроизводит текст ответа.
   *
   * Исправление HTTP 400 от ExoPlayer (InvalidResponseCodeException):
   * Google Translate TTS (особенно client=tw-ob) часто отвечает 400 на
   * длинные/кириллические фразы или без корректного User-Agent при прямом
   * URI в Audio.Sound. Решение:
   *  - client=gtx (более устойчивый);
   *  - короткие чанки ≤ 160 символов с разбивкой по пробелам/точкам;
   *  - при ошибке 400/сети — пропуск чанка, а не падение всего озвучивания;
   *  - последовательное воспроизведение чанков.
   */
  public async speakText(
    messageId: string,
    rawText: string,
    language: string = "ru",
    options: { speed?: number; readCodeBlocks?: boolean } = {}
  ): Promise<void> {
    await this.stop();

    const prepared = formatTextForSpeech(rawText, {
      language,
      readCodeBlocks: options.readCodeBlocks,
    });
    if (!prepared) return;

    this.currentPlayingId = messageId;
    this.notifyStatusChange(messageId);

    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        allowsRecordingIOS: false,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });

      const langCode = language === "en" ? "en" : language === "uk" ? "uk" : "ru";
      const rate = Math.max(0.5, Math.min(2.0, options.speed || 1.0));

      // Короткие чанки — Google TTS лимит ~200 символов, 400 чаще на длинных.
      const chunks: string[] = [];
      const maxChunk = 160;
      let remaining = prepared;
      while (remaining.length > 0) {
        if (remaining.length <= maxChunk) {
          chunks.push(remaining);
          break;
        }
        let cut = remaining.lastIndexOf(" ", maxChunk);
        if (cut < 30) cut = remaining.lastIndexOf(".", maxChunk);
        if (cut < 30) cut = remaining.lastIndexOf(",", maxChunk);
        if (cut < 30) cut = maxChunk;
        const part = remaining.slice(0, cut).trim();
        if (part) chunks.push(part);
        remaining = remaining.slice(cut).trim();
      }

      for (let i = 0; i < chunks.length; i++) {
        if (this.currentPlayingId !== messageId) break;
        const chunk = chunks[i];
        if (!chunk) continue;

        // client=gtx обычно стабильнее tw-ob и реже отдаёт 400.
        const audioUrl =
          `https://translate.google.com/translate_tts?ie=UTF-8&client=gtx&tl=${langCode}` +
          `&q=${encodeURIComponent(chunk)}`;

        try {
          const { sound } = await Audio.Sound.createAsync(
            { uri: audioUrl },
            { shouldPlay: true, rate },
            undefined
          );
          this.currentSound = sound;

          // Ждём окончания чанка перед следующим
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            sound.setOnPlaybackStatusUpdate((status) => {
              if (status.isLoaded && (status.didJustFinish || !status.isPlaying)) {
                finish();
              }
            });
            // safety timeout
            setTimeout(finish, Math.max(3500, chunk.length * 85));
          });

          try {
            await sound.unloadAsync();
          } catch {
            // ignore
          }
          this.currentSound = null;
        } catch (chunkErr: unknown) {
          // HTTP 400 / сеть / ExoPlayer — пропускаем этот чанк, продолжаем остальные.
          // Не бросаем наружу, чтобы кнопка «Озвучить» не показывала красную ошибку
          // на каждом ответе при временных ограничениях Google.
          const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
          if (!/400|InvalidResponseCode|HttpDataSource|network|timeout/i.test(msg)) {
            // неожиданная ошибка — тоже soft-fail для чанка
          }
          this.currentSound = null;
          continue;
        }
      }
    } catch (err) {
      this.stop();
      // Полный fail только если совсем ничего не удалось (редко)
      throw err;
    } finally {
      if (this.currentPlayingId === messageId) {
        this.currentPlayingId = null;
        this.notifyStatusChange(null);
      }
    }
  }
}

export const voicePlayback = new VoicePlaybackManager();
