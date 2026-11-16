import { createContext, useContext, ReactNode } from "react";
import { useLLM } from "../hooks/useLLM";

type LLMContextType = ReturnType<typeof useLLM>;

const LLMContext = createContext<LLMContextType | null>(null);

// Без этого провайдера каждый экран, вызывающий useLLM() напрямую,
// получал свою ОТДЕЛЬНУЮ копию состояния (список чатов, текущий чат).
// Из-за этого "История чатов" была полностью не связана с экраном чата:
// переключение чата в истории ни на что не влияло. Провайдер держит
// одно общее состояние на всё приложение.
export function LLMProvider({ children }: { children: ReactNode }) {
  const llm = useLLM();
  return <LLMContext.Provider value={llm}>{children}</LLMContext.Provider>;
}

export function useLLMContext() {
  const ctx = useContext(LLMContext);
  if (!ctx) throw new Error("useLLMContext must be used within LLMProvider");
  return ctx;
}
