import { Component, ReactNode } from "react";
import { View, Text, TouchableOpacity, StyleSheet, DevSettings } from "react-native";
import { persistentLogger } from "../lib/persistent-logger";
import { useLanguage } from "./LanguageContext";

/**
 * Раньше рендер-ошибка внутри дерева компонентов (например, необработанное
 * исключение в компоненте экрана) ничем не отличалась для пользователя от
 * обычного краша: приложение просто останавливалось. Теперь такая ошибка
 * ловится здесь, сразу пишется в персистентный лог (lib/persistent-logger.ts
 * — переживает перезапуск) и показывается понятный экран вместо пустого
 * "вылета".
 */

interface InnerProps {
  children?: ReactNode;
  title: string;
  message: string;
  restartLabel: string;
}

interface InnerState {
  error: Error | null;
  componentStack: string | null;
}

class ErrorBoundaryInner extends Component<InnerProps, InnerState> {
  state: InnerState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<InnerState> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const stack = error.stack ? `\n${error.stack}` : "";
    const componentStack = info?.componentStack ? `\nComponent stack:${info.componentStack}` : "";
    persistentLogger.add("error", "Crash", `[RENDER ERROR] ${error.name}: ${error.message}${stack}${componentStack}`);
    this.setState({ componentStack: info?.componentStack || null });
  }

  handleRestart = () => {
    this.setState({ error: null });
    try {
      // DevSettings.reload() перезапускает JS-бандл и в release-сборках —
      // это тот же официальный API, которым пользуются CodePush и т.п.
      DevSettings.reload();
    } catch {
      // если недоступно — пользователь как минимум увидит сброшенный экран
    }
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>{this.props.title}</Text>
          <Text style={styles.message}>{this.props.message}</Text>
          {!!this.state.error?.message && (
            <Text style={styles.errorDetail} selectable>
              {this.state.error.name}: {this.state.error.message}
            </Text>
          )}
          {!!this.state.error?.stack && (
            <Text style={styles.errorDetail} selectable>
              {this.state.error.stack.split("\n").slice(0, 8).join("\n")}
            </Text>
          )}
          {!!this.state.componentStack && (
            <Text style={styles.errorDetail} selectable>
              {this.state.componentStack.trim().split("\n").slice(0, 12).join("\n")}
            </Text>
          )}
          <TouchableOpacity style={styles.button} onPress={this.handleRestart}>
            <Text style={styles.buttonText}>{this.props.restartLabel}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  return (
    <ErrorBoundaryInner
      title={t("crashTitle")}
      message={t("crashMessage")}
      restartLabel={t("crashRestart")}
    >
      {children}
    </ErrorBoundaryInner>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#101418",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 12,
    textAlign: "center",
  },
  message: {
    color: "#9AA3AC",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 24,
  },
  button: {
    backgroundColor: "#9FCBFF",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  buttonText: {
    color: "#00325A",
    fontSize: 16,
    fontWeight: "700",
  },
  errorDetail: {
    color: "#FFB4AB",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    marginBottom: 20,
    paddingHorizontal: 8,
  },
});
