import { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react";
import { AppDialog, AppDialogButton } from "./AppDialog";

interface DialogState {
  visible: boolean;
  title: string;
  message?: string;
  commands?: string[];
  copyLabel?: string;
  copiedLabel?: string;
  buttons: AppDialogButton[];
  onButtonPress?: (button: AppDialogButton, index: number) => void;
}

interface ShowDialogOptions {
  commands?: string[];
  copyLabel?: string;
  copiedLabel?: string;
}

interface DialogContextType {
  // Замена системного Alert.alert: показывает окно в стиле приложения,
  // а не стандартный серый диалог Android.
  showDialog: (
    title: string,
    message?: string,
    buttons?: AppDialogButton[],
    options?: ShowDialogOptions
  ) => void;
  /** Promise-діалог підтвердження (для небезпечних Termux-команд). */
  confirmDialog: (title: string, message: string, confirmText?: string, cancelText?: string) => Promise<boolean>;
}

const DialogContext = createContext<DialogContextType | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({ visible: false, title: "", buttons: [] });
  const pendingConfirmRef = useRef<((value: boolean) => void) | null>(null);

  const settlePendingConfirm = useCallback((value: boolean) => {
    const resolve = pendingConfirmRef.current;
    pendingConfirmRef.current = null;
    resolve?.(value);
  }, []);

  const showDialog = useCallback(
    (title: string, message?: string, buttons?: AppDialogButton[], options?: ShowDialogOptions) => {
      settlePendingConfirm(false);
      setState({
        visible: true,
        title,
        message,
        commands: options?.commands,
        copyLabel: options?.copyLabel,
        copiedLabel: options?.copiedLabel,
        buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK" }],
        onButtonPress: undefined,
      });
    },
    [settlePendingConfirm]
  );

  const confirmDialog = useCallback(
    (title: string, message: string, confirmText = "OK", cancelText = "Cancel") => {
      return new Promise<boolean>((resolve) => {
        settlePendingConfirm(false);
        pendingConfirmRef.current = resolve;
        // "default" — не красим подтверждение как удаление (Termux bridge и т.п.).
        // Опасные действия по-прежнему описываются текстом title/message.
        setState({
          visible: true,
          title,
          message,
          buttons: [
            { text: cancelText, style: "cancel", onPress: () => settlePendingConfirm(false) },
            { text: confirmText, style: "default", onPress: () => settlePendingConfirm(true) },
          ],
          onButtonPress: (button) => {
            button.onPress?.();
            setState((current) => ({ ...current, visible: false, onButtonPress: undefined }));
          },
        });
      });
    },
    [settlePendingConfirm]
  );

  const close = useCallback(() => {
    settlePendingConfirm(false);
    setState((s) => ({ ...s, visible: false, onButtonPress: undefined }));
  }, [settlePendingConfirm]);

  return (
    <DialogContext.Provider value={{ showDialog, confirmDialog }}>
      {children}
      <AppDialog
        visible={state.visible}
        title={state.title}
        message={state.message}
        commands={state.commands}
        copyLabel={state.copyLabel}
        copiedLabel={state.copiedLabel}
        buttons={state.buttons}
        onButtonPress={state.onButtonPress}
        onRequestClose={close}
      />
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}
