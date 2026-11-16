import { useEffect, useRef, useState } from "react";
import { Animated, Easing, View, Text, StyleSheet, LayoutChangeEvent } from "react-native";
import { useTheme } from "./ThemeContext";

interface Props {
  progress: number;
  indeterminate?: boolean;
  label?: string;
  sublabel?: string;
}

export function ProgressBar({ progress, indeterminate = false, label, sublabel }: Props) {
  const { colors } = useTheme();
  const clamped = Math.min(100, Math.max(0, progress));
  const [trackWidth, setTrackWidth] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!indeterminate || trackWidth <= 0) {
      sweep.stopAnimation();
      sweep.setValue(0);
      return;
    }
    sweep.setValue(-trackWidth * 0.4);
    const loop = Animated.loop(Animated.timing(sweep, {
      toValue: trackWidth,
      duration: 1100,
      easing: Easing.linear,
      useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [indeterminate, trackWidth, sweep]);

  const onTrackLayout = (event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setTrackWidth((current) => Math.abs(current - nextWidth) < 1 ? current : nextWidth);
  };

  return (
    <View style={styles.container}>
      {label && <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>}
      <View style={[styles.track, { backgroundColor: colors.line }]} onLayout={onTrackLayout}>
        {indeterminate ? (
          <Animated.View style={[styles.fill, { width: "36%", backgroundColor: colors.accent, transform: [{ translateX: sweep }] }]} />
        ) : (
          <View style={[styles.fill, { width: `${clamped}%`, backgroundColor: colors.accent }]} />
        )}
      </View>
      <View style={styles.footerRow}>
        {!indeterminate && <Text style={[styles.percent, { color: colors.accent }]}>{Math.round(clamped)}%</Text>}
        {!!sublabel && <Text style={[styles.sublabel, { color: colors.muted }]}>{sublabel}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: 4 },
  label: { fontSize: 12, marginBottom: 4 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3 },
  footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  percent: { fontSize: 11, fontWeight: "600" },
  sublabel: { fontSize: 11, flex: 1, textAlign: "right", marginLeft: 8 },
});
